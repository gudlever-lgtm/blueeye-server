'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

// Packages the agent source tree into a single gzipped tarball, served at
// GET /enroll/agent-source.tgz for the one-line installer.
//
// The whole point: the installer fetches the agent FROM this server (no GitHub,
// no registry, works air-gapped) and then builds + runs it with Docker (or Node)
// on the target — so NO pre-built binaries are ever published. The agent source
// already sits beside the server in the standard deploy layout; point
// AGENT_SOURCE_DIR at it (the compose file bind-mounts ../blueeye-agent).
//
// The archive is built once at startup and its SHA-256 cached (embedded into the
// install script for integrity verification), mirroring the artifact store. Call
// reload() after the source changes (e.g. an agent upgrade on the host).
//
// THE ARCHIVE IS REPRODUCIBLE, AND IT HAS TO BE. The checksum is embedded in the
// install/update script when that script is GENERATED; the tarball is fetched in
// a SEPARATE request afterwards. The two therefore only agree while the bytes in
// between do not change — and a plain `tar` archive of identical source does not
// hash the same twice, because tar records each file's mtime, its uid/gid, and
// whatever order the directory walk returned.
//
// The mtimes are the one that bites. `git clone` and most deploy tooling write
// them fresh, so the SAME COMMIT packaged on two machines, or on one machine
// twice, produced different bytes. That made the checksum a property of WHEN the
// server last packaged rather than of WHAT the source is, and it failed in three
// ways:
//
//   * a restart or a reload() between the script and the download → mismatch,
//     which an operator sees as "checksum mismatch - refusing to update" on a
//     host that updated perfectly an hour earlier;
//   * two server replicas → the script from one NEVER validates the bytes from
//     the other, because each packaged its own tarball from its own checkout;
//   * redeploying the same commit → new mtimes, new checksum, same source.
//
// Fixed by pinning everything that varies: `--sort=name` for the order,
// `--mtime=@0` for the timestamps, `--owner/--group/--numeric-owner` for the
// ownership.
//
// The gzip is done HERE rather than through tar's `-z` for the same reason one
// step further out. GNU tar compressing a stream happens to write a zero MTIME
// into the gzip header, so `-z` was not itself a source of drift — but that is
// a property of one tar talking to one gzip, not a guarantee, and the `gzip`
// binary writing now() into that field is the documented default. zlib.gzipSync
// always writes zero. Same source in, same bytes out, whichever tar the host
// happens to ship.
//
// DI-friendly: pass a fake `exec`/`fsImpl` in tests, or point `dir` at a fixture.

// Directories/files never worth shipping. node_modules is reinstalled on the
// target anyway (the Dockerfile runs `npm ci`); the rest could leak local
// secrets/config from the checkout, so they're excluded from the bundle that
// goes to every enrolled host.
const EXCLUDES = [
  './node_modules', './.git', './dist', './test', './test-support', './.github',
  './.env', './.env.local', './.blueeye-agent', './blueeye-agent.config.json',
  '*.token', '*.log',
];

// What makes two runs over identical source produce identical bytes. GNU tar
// only — busybox tar (the one in a bare alpine image) rejects every one of
// them, which is why the server image installs GNU tar and why the build below
// falls back rather than serving nothing.
const TAR_REPRODUCIBLE = [
  '--sort=name',
  '--mtime=@0',
  '--owner=0',
  '--group=0',
  '--numeric-owner',
];

function createAgentSourceStore({ dir, exec = spawnSync, fsImpl = fs, logger = console } = {}) {
  let cache = null; // { buffer, sha256, size }
  let uninstall = null; // raw uninstall.sh content, served at /enroll/uninstall.sh
  let srcVersion = null; // agent package.json version (for "is this agent up to date?")

  function warn(msg) {
    if (logger && typeof logger.warn === 'function') logger.warn(msg);
  }

  function build() {
    cache = null;
    uninstall = null;
    srcVersion = null;
    if (!dir) {
      warn('enroll: AGENT_SOURCE_DIR not set — agent source unavailable (install.sh will explain).');
      return;
    }
    let stat;
    try {
      stat = fsImpl.statSync(dir);
    } catch (err) {
      warn(`enroll: agent source dir unavailable (${dir}): ${err.message}`);
      return;
    }
    if (!stat.isDirectory()) {
      warn(`enroll: agent source path is not a directory (${dir}).`);
      return;
    }

    // Cache the uninstall helper so it can be served as a one-liner. Independent
    // of the tarball — uninstalling doesn't need the source bundle.
    try {
      uninstall = fsImpl.readFileSync(path.join(dir, 'uninstall.sh'), 'utf8');
    } catch {
      uninstall = null;
    }

    // The version of the agent we serve — used to flag out-of-date agents.
    try {
      const pkg = JSON.parse(fsImpl.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      srcVersion = (pkg && pkg.version) || null;
    } catch {
      srcVersion = null;
    }

    // `-cf`, not `-czf`: the gzip happens below, in Node, where the header's
    // MTIME field is always zero rather than up to the host's gzip.
    const tarArgs = (reproducible) => [
      '-cf', '-',
      ...(reproducible ? TAR_REPRODUCIBLE : []),
      '-C', dir,
      ...EXCLUDES.map((e) => `--exclude=${e}`),
      '.',
    ];
    const failed = (r) => r.error || r.status !== 0 || !r.stdout || r.stdout.length === 0;
    const why = (r) => (r.error ? r.error.message : r.stderr ? String(r.stderr).trim() : `exit ${r.status}`);

    let reproducible = true;
    let res = exec('tar', tarArgs(true), { maxBuffer: 256 * 1024 * 1024 });
    if (failed(res)) {
      // A tar that does not understand the flags — busybox, or something very
      // old. Serving an unstable checksum is bad; serving NO agent source is
      // worse, because then nothing can enrol or update at all. So fall back,
      // and say plainly what the consequence is.
      reproducible = false;
      warn(`enroll: this tar cannot build a reproducible archive (${why(res)}). `
        + 'Falling back to a non-reproducible one: the source checksum will change on every '
        + 'restart, so an update can fail with "checksum mismatch" when the script and the '
        + 'download come from different builds. Install GNU tar (alpine: apk add tar).');
      res = exec('tar', tarArgs(false), { maxBuffer: 256 * 1024 * 1024 });
    }
    if (failed(res)) {
      warn(`enroll: failed to package agent source from ${dir}: ${why(res)}`);
      return;
    }

    const tarBytes = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout);
    // level 9 fixed rather than left to the default, so the output depends only
    // on the input. zlib.gzipSync writes MTIME=0, which the gzip binary does not.
    const buffer = zlib.gzipSync(tarBytes, { level: 9 });
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    cache = { buffer, sha256, size: buffer.length };
    if (logger && typeof logger.info === 'function') {
      // The VERSION is the part an operator needs. "I deployed but the dashboard
      // still offers the old agent" is answered by this one line —
      // `docker compose logs server | grep 'agent source packaged'` — with no
      // API token and no dashboard login.
      logger.info(`enroll: agent source packaged v${srcVersion || '?'} from ${dir} `
        + `(${buffer.length} bytes, sha256 ${sha256.slice(0, 12)}…`
        + `${reproducible ? '' : ', NOT reproducible'}).`);
    }
  }

  build();

  return {
    reload: build,
    available() {
      return cache != null;
    },
    // Raw uninstall.sh (served at /enroll/uninstall.sh), or null when absent.
    uninstallScript() {
      return uninstall;
    },
    // The version of the agent source we serve (its package.json version), or null.
    sourceVersion() {
      return srcVersion;
    },
    buffer() {
      return cache ? cache.buffer : null;
    },
    get sha256() {
      return cache ? cache.sha256 : null;
    },
    get size() {
      return cache ? cache.size : 0;
    },
    // Metadata for the download endpoint (no buffer), or null when unavailable.
    meta() {
      if (!cache) return null;
      return {
        filename: 'blueeye-agent-source.tgz',
        contentType: 'application/gzip',
        size: cache.size,
        sha256: cache.sha256,
      };
    },
  };
}

module.exports = { createAgentSourceStore };
