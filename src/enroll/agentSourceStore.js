'use strict';

const fs = require('fs');
const crypto = require('crypto');
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
// DI-friendly: pass a fake `exec`/`fsImpl` in tests, or point `dir` at a fixture.

// Directories never worth shipping (and node_modules is reinstalled on the
// target anyway — the Dockerfile runs `npm ci`).
const EXCLUDES = ['./node_modules', './.git', './dist', './test', './test-support', './.github'];

function createAgentSourceStore({ dir, exec = spawnSync, fsImpl = fs, logger = console } = {}) {
  let cache = null; // { buffer, sha256, size }

  function warn(msg) {
    if (logger && typeof logger.warn === 'function') logger.warn(msg);
  }

  function build() {
    cache = null;
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

    const args = ['-czf', '-', '-C', dir, ...EXCLUDES.map((e) => `--exclude=${e}`), '.'];
    const res = exec('tar', args, { maxBuffer: 256 * 1024 * 1024 });
    if (res.error || res.status !== 0 || !res.stdout || res.stdout.length === 0) {
      const why = res.error ? res.error.message : res.stderr ? String(res.stderr).trim() : `exit ${res.status}`;
      warn(`enroll: failed to package agent source from ${dir}: ${why}`);
      return;
    }

    const buffer = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    cache = { buffer, sha256, size: buffer.length };
    if (logger && typeof logger.info === 'function') {
      logger.info(`enroll: agent source packaged (${buffer.length} bytes, sha256 ${sha256.slice(0, 12)}…).`);
    }
  }

  build();

  return {
    reload: build,
    available() {
      return cache != null;
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
