'use strict';

const fs = require('fs');
const { canonicalize } = require('../lib/canonicalize');
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { renderInstallScript } = require('../enroll/installScript');
const { renderInstallPs1, renderUpdatePs1, renderUninstallPs1 } = require('../enroll/installScriptWin');
const { renderRepinScript } = require('../enroll/repinScript');

// Only allow a sane host[:port] when deriving the server URL from the request,
// so a forged Host header can't be reflected into the install script.
const SAFE_HOST_RE = /^[a-zA-Z0-9.\-:[\]]+$/;

// The canonical URL clients should use to reach this server: the configured
// public URL if set (recommended behind a reverse proxy), otherwise derived
// from the incoming request (works for direct/local access).
function resolveServerUrl(req, enrollConfig) {
  const configured = enrollConfig && enrollConfig.publicUrl;
  if (configured) return String(configured).replace(/\/+$/, '');
  const host = req.get('host') || '';
  const proto = req.protocol || 'http';
  if (!SAFE_HOST_RE.test(host)) return `${proto}://localhost`;
  return `${proto}://${host}`;
}

// Nothing under /enroll may be cached by anything in between. The install and
// update scripts carry the SHA-256 of the source bundle EMBEDDED in them, and the
// bundle is fetched in a separate request afterwards, so a cache that keeps
// either one for a while hands the host a script and a tarball from two
// different server builds — which surfaces on the target as
// "checksum mismatch - refusing to update" on a host that updated fine an hour
// earlier, and stays that way until the cache expires. A CDN or reverse proxy in
// front will happily cache a .tgz (a static-looking extension) by heuristic when
// the response says nothing, so the response has to say something.
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

// PUBLIC (unauthenticated) enrollment helpers, mounted at /enroll. A new agent
// has no token yet, so these must be reachable without auth:
//   GET /enroll/config                 -> { serverUrl, certFingerprint, releasePublicKey }
//   GET /enroll/agent-source.tgz       -> the agent source bundle (built + run on the target)
//   GET /enroll/agent-source.sha256    -> the SHA-256 of that bundle, as it is RIGHT NOW
//   GET /enroll/agent-release-key      -> the release trust anchor (PEM) the agent pins
//   GET /enroll/agent-binary/:arch     -> auto-built self-contained binary (linux-x64|linux-arm64)
//   GET /enroll/agent-binary-status    -> build status for operator inspection
//   GET /enroll/agent/:platform        -> manually-dropped binary (legacy; only if published)
//   GET /enroll/:code/install.sh       -> the one-line installer for that code
//   GET /enroll/repin.sh               -> re-anchor an installed agent to this server's key
//   GET /enroll/update.ps1             -> the Windows update-in-place one-liner
function createEnrollRouter({ artifactStore, sourceStore, binaryStore, releaseStore, enrollmentCodesRepo, enrollConfig = {}, releasePublicKey = '' }) {
  const router = express.Router();
  const certFingerprint = enrollConfig.certFingerprint || '';
  // releasePublicKey may be a live resolver (it can change at runtime when an admin
  // generates/deletes the key) or a plain string (tests). Resolve per request.
  const pubKey = () => (typeof releasePublicKey === 'function' ? releasePublicKey() : releasePublicKey) || '';

  // Companion config so the binary can learn the server URL + fingerprint to pin
  // when they weren't embedded at install time.
  router.get('/config', (req, res) => {
    res.json({
      serverUrl: resolveServerUrl(req, enrollConfig),
      certFingerprint: certFingerprint || null,
      releasePublicKey: pubKey() || null,
    });
  });

  // The release trust anchor (Ed25519 PUBLIC key) the agent pins to verify SIGNED
  // self-updates. Public, not secret — served unauthenticated as raw PEM so the
  // installer can fetch + bake it in with no key handling. 404 when unconfigured
  // (in which case the server publishes no signed releases either).
  router.get('/agent-release-key', (req, res) => {
    const key = pubKey();
    if (!key) {
      res.status(404).type('text/plain; charset=utf-8');
      return res.send('# No agent release public key configured on this server.\n');
    }
    const pem = key.endsWith('\n') ? key : `${key}\n`;
    res.status(200).type('text/plain; charset=utf-8').send(pem);
  });

  // Re-pin an ALREADY-INSTALLED agent to the release key this server serves now.
  // An agent refuses an update that is not signed by the key it pinned at install
  // time, so a server whose signing key changed (rotated, regenerated, or no
  // longer decryptable) can no longer update its own fleet — and re-running the
  // installer is not an answer, because that needs an enrollment code and would
  // onboard a second agent for the same host. This script only rewrites the
  // release-key drop-in and restarts the service.
  //
  // Public for the same reason as install.sh: the host running it has no
  // dashboard session, and the script hands out nothing secret — the release
  // PUBLIC key is already served unauthenticated at /enroll/agent-release-key.
  // 404 while this server has no key to pin, so the script can never point a
  // host at an empty anchor.
  router.get('/repin.sh', (req, res) => {
    if (!pubKey()) {
      res.status(404).type('text/plain; charset=utf-8');
      return res.send('# No agent release public key configured on this server — generate one under Settings -> Agent key first.\n');
    }
    const script = renderRepinScript({
      serverUrl: resolveServerUrl(req, enrollConfig),
      serviceName: (enrollConfig && enrollConfig.serviceName) || 'blueeye-agent',
    });
    noStore(res);
    res.status(200).type('text/x-shellscript; charset=utf-8').send(script);
  });

  // Serve the agent SOURCE bundle (a gzipped tarball), packaged + checksummed at
  // startup. This is what the one-line installer downloads and then builds + runs
  // with Docker/Node — so no pre-built binaries are needed. 404 when no source is
  // configured (AGENT_SOURCE_DIR). The cached SHA-256 is exposed as a header.
  //
  // `?sha=<hex>` is how the install/update scripts ask for the exact bundle their
  // embedded checksum belongs to. Two things come out of it: the URL differs per
  // build, so no cache in front can serve a stale tarball under it, and when the
  // server HAS repackaged since the script was generated the answer is a 409 that
  // says so, instead of a tarball the script then rejects as corrupt.
  router.get('/agent-source.tgz', asyncHandler(async (req, res) => {
    const meta = sourceStore && sourceStore.meta();
    const buffer = sourceStore && sourceStore.buffer();
    noStore(res);
    if (!meta || !buffer) {
      return res.status(404).json({ error: 'No agent source published on this server' });
    }
    const want = typeof req.query.sha === 'string' ? req.query.sha.trim().toLowerCase() : '';
    if (want && want !== meta.sha256) {
      return res.status(409).json({
        error: 'Agent source has been repackaged since that script was generated',
        requested: want,
        current: meta.sha256,
        hint: 'Re-run the one-liner to get a script carrying the current checksum.',
      });
    }
    res.setHeader('Content-Type', meta.contentType);
    res.setHeader('Content-Length', meta.size);
    res.setHeader('X-Content-SHA256', meta.sha256);
    res.setHeader('ETag', `"${meta.sha256}"`);
    res.setHeader('Content-Disposition', `attachment; filename="${meta.filename}"`);
    res.status(200).send(buffer);
  }));

  // The checksum of the bundle this server is serving right now, as plain text
  // (one lowercase hex line). The scripts read it when their own verification
  // fails, so they can tell the operator WHICH side is stale — the script or the
  // download — rather than only that the two disagree.
  router.get('/agent-source.sha256', (req, res) => {
    const meta = sourceStore && sourceStore.meta();
    noStore(res);
    res.type('text/plain; charset=utf-8');
    if (!meta) {
      return res.status(404).send('# No agent source is published on this server.\n');
    }
    res.setHeader('X-Agent-Version', sourceStore.sourceVersion() || '');
    res.setHeader('X-Content-SHA256', meta.sha256);
    return res.status(200).send(`${meta.sha256}\n`);
  });

  // Latest SIGNED agent release — metadata only (JSON), so an agent can learn the
  // version/sha256/signature to verify against. 404 when no release is published.
  router.get('/agent-release', asyncHandler(async (req, res) => {
    const rel = releaseStore && typeof releaseStore.latest === 'function' ? releaseStore.latest() : null;
    noStore(res);
    if (!rel) {
      return res.status(404).json({ error: 'No signed agent release published on this server' });
    }
    res.json({ version: rel.version, sha256: rel.sha256, size: rel.size, signature: rel.signature, manifest: rel.manifest });
  }));

  // Latest SIGNED agent release — the tarball bytes plus verification headers
  // (version, sha256, Ed25519 signature, base64 manifest). The agent downloads
  // this and verifies the signature + sha256 BEFORE extracting, so integrity
  // rests on the signature — hence served unauthenticated, like the source bundle.
  router.get('/agent-release.tgz', asyncHandler(async (req, res) => {
    const rel = releaseStore && typeof releaseStore.latest === 'function' ? releaseStore.latest() : null;
    const full = rel && typeof releaseStore.get === 'function' ? releaseStore.get(rel.version) : null;
    noStore(res);
    if (!full || !full.buffer) {
      // A release is indexed but its bytes could not be served: the store found
      // them missing or not matching the manifest it signed (it logs which).
      // Saying "none published" there would be a lie the operator cannot act on
      // — every agent would just keep reporting a checksum mismatch.
      if (rel) {
        return res.status(503).json({
          error: `The published agent release ${rel.version} cannot be served: its stored bytes do not match the manifest it was signed with`,
          hint: 'Restart the server to re-sign the release from the agent source, or re-upload it. See the server log.',
        });
      }
      return res.status(404).json({ error: 'No signed agent release published on this server' });
    }
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', full.size);
    res.setHeader('X-Content-SHA256', full.sha256);
    res.setHeader('X-Release-Version', full.version);
    res.setHeader('X-Release-Signature', full.signature);
    // base64 of the CANONICAL bytes — the exact bytes the signature was made
    // over (src/lib/canonicalize.js: keys sorted, no whitespace). JSON.stringify
    // preserves insertion order, so the manifest is built as
    // {version, sha256, size, created_at} but signed as
    // {created_at, sha256, size, version}. A client that verified
    // X-Release-Signature against a base64-decode of this header therefore got
    // "invalid signature" every single time, for bytes that were never
    // tampered with. Serving what was signed is what makes the header usable:
    // the consumer verifies these bytes directly and does not have to
    // reimplement the canonical form to do it.
    res.setHeader('X-Release-Manifest', Buffer.from(canonicalize(full.manifest), 'utf8').toString('base64'));
    res.setHeader('Content-Disposition', `attachment; filename="blueeye-agent-${full.version}.tgz"`);
    res.status(200).send(full.buffer);
  }));

  // The uninstall one-liner: serve the agent's uninstall.sh so an operator can run
  //   curl -sSL <server>/enroll/uninstall.sh | sudo sh
  // to remove the agent from a host. No code needed (uninstalling isn't gated by
  // enrollment); the script itself warns + asks for confirmation before acting.
  router.get('/uninstall.sh', asyncHandler(async (req, res) => {
    const script = sourceStore && sourceStore.uninstallScript();
    if (!script) {
      res.status(404).type('text/plain; charset=utf-8');
      return res.send('# No uninstall script available on this server.\n');
    }
    noStore(res);
    res.status(200).type('text/x-shellscript; charset=utf-8').send(script);
  }));

  // Auto-built self-contained binaries (~60 MB each).  The server builds these at
  // startup using @yao-pkg/pkg; 404 before the build completes or when pkg is not
  // installed.  Use GET /enroll/agent-binary-status to see build progress.
  router.get('/agent-binary/:arch', asyncHandler(async (req, res) => {
    const arch = req.params.arch;
    if (!binaryStore) {
      return res.status(404).json({ error: 'Binary store not configured on this server' });
    }
    const entry = binaryStore.get(arch);
    if (!entry) {
      const st = binaryStore.status();
      const archSt = st.arches[arch];
      if (archSt && archSt.status === 'building') {
        return res.status(503).json({ error: 'Binary is still building — retry in a few minutes', arch, status: 'building' });
      }
      return res.status(404).json({ error: 'No binary available for this arch', arch });
    }
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Content-Length', entry.size);
    res.setHeader('X-Content-SHA256', entry.sha256);
    res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(entry.path);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    });
  }));

  // Build status for operator inspection (no auth required — operators may need
  // this before a session exists). Public, so the build's error TEXT is not
  // relayed: it carries the cache-dir path and the tail of the packager's
  // output. The route says which arches failed; the message is in the server
  // log, where the store already writes it.
  router.get('/agent-binary-status', (req, res) => {
    if (!binaryStore) {
      return res.json({ configured: false });
    }
    res.json({ configured: true, ...publicBinaryStatus(binaryStore.status()) });
  });

  // Serve a pre-built agent binary for a platform from the local artifacts dir.
  // LEGACY/optional: the default install flow uses the source bundle above, so
  // this only responds when an operator has dropped a binary in. 404 otherwise.
  router.get('/agent/:platform', asyncHandler(async (req, res) => {
    if (!artifactStore) {
      return res.status(404).json({ error: 'No agent binary for that platform', platform: req.params.platform });
    }
    const entry = artifactStore.get(req.params.platform);
    if (!entry) {
      return res.status(404).json({ error: 'No agent binary for that platform', platform: req.params.platform });
    }
    res.setHeader('Content-Type', entry.contentType || 'application/octet-stream');
    res.setHeader('Content-Length', entry.size);
    res.setHeader('X-Content-SHA256', entry.sha256);
    res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(entry.path);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    });
  }));

  // The one-line installer. 404 for an unknown/expired/exhausted code (so a bad
  // code never yields a runnable script). Served as a shell script.
  router.get('/:code/install.sh', asyncHandler(async (req, res) => {
    const row = await enrollmentCodesRepo.findByCode(req.params.code);
    if (!row || row.status !== 'active') {
      res.status(404).type('text/plain; charset=utf-8');
      return res.send('# Unknown, expired or exhausted enrollment code.\n');
    }
    const script = renderInstallScript({
      serverUrl: resolveServerUrl(req, enrollConfig),
      code: req.params.code,
      certFingerprint,
      sourceSha: sourceStore ? sourceStore.sha256 : '',
      binaryChecksums: binaryStore ? binaryStore.checksums() : {},
      agentVersion: sourceStore ? sourceStore.sourceVersion() : '',
    });
    noStore(res);
    res.status(200).type('text/x-shellscript; charset=utf-8').send(script);
  }));

  // The Windows installer (PowerShell). Same contract as install.sh but for hosts
  // where `curl … | sh` cannot run. The operator downloads it to a file and runs
  // the file (see winRunSteps) rather than piping it into `iex`. Served as an
  // attachment with ?download=1, so it can also be saved straight from a browser
  // and carried to a host that cannot reach the server. 404 for an
  // unknown/expired/exhausted code so a bad code never yields a runnable script.
  router.get('/:code/install.ps1', asyncHandler(async (req, res) => {
    const row = await enrollmentCodesRepo.findByCode(req.params.code);
    if (!row || row.status !== 'active') {
      res.status(404).type('text/plain; charset=utf-8');
      return res.send('# Unknown, expired or exhausted enrollment code.\n');
    }
    const script = renderInstallPs1({
      serverUrl: resolveServerUrl(req, enrollConfig),
      code: req.params.code,
      certFingerprint,
      sourceSha: sourceStore ? sourceStore.sha256 : '',
      agentVersion: sourceStore ? sourceStore.sourceVersion() : '',
    });
    sendPs1(req, res, script, 'blueeye-install.ps1');
  }));

  // The Windows UPDATER (PowerShell), served at GET /enroll/update.ps1 for a host
  // whose agent is already enrolled. It replaces the agent's CODE in
  // place and never enrolls, so — unlike install.ps1 — it needs no enrollment code
  // and cannot produce a second agent: the script aborts on a host with no
  // installed, enrolled agent. Public for the same reason as install.ps1 (the host
  // has no dashboard session), and integrity rests on the embedded SHA-256 of the
  // source bundle plus the pinned TLS fetch. 404 when no agent source is published.
  router.get('/update.ps1', (req, res) => {
    const sha = sourceStore ? sourceStore.sha256 : '';
    if (!sha) {
      res.status(404).type('text/plain; charset=utf-8');
      return res.send('# No agent source is published on this server, so there is nothing to update to.\n');
    }
    const script = renderUpdatePs1({
      serverUrl: resolveServerUrl(req, enrollConfig),
      certFingerprint,
      sourceSha: sha,
      agentVersion: sourceStore.sourceVersion ? sourceStore.sourceVersion() : '',
    });
    sendPs1(req, res, script, 'blueeye-update.ps1');
  });

  // The Windows uninstaller (PowerShell) — the analogue of uninstall.sh, so a
  // Windows host removes the agent by downloading and running this script rather
  // than a bash `curl … | sudo sh`. No code needed; static + best-effort.
  router.get('/uninstall.ps1', (req, res) => {
    sendPs1(req, res, renderUninstallPs1(), 'blueeye-uninstall.ps1');
  });

  return router;
}

// Send a generated PowerShell script. text/plain by default so it can simply be
// read in a browser; with ?download=1 it comes back as a named attachment instead,
// which is how an operator saves it to disk — either to inspect it before running,
// or to carry it to a host that cannot reach this server itself.
//
// The body is prefixed with a UTF-8 BOM. Windows PowerShell 5.1 reads a BOM-less
// .ps1 in the system ANSI code page (Windows-1252 on a Danish/Western host), so
// any UTF-8 multi-byte character in the script is mis-decoded — an em-dash comes
// out as "â€”", whose trailing "”" (U+201D) PowerShell accepts as a closing
// double quote, and the whole file fails to parse ("Unexpected token", "Missing
// closing ')'"). The BOM makes 5.1 decode the file as UTF-8 regardless of the
// host's code page; PowerShell 7 and `Invoke-WebRequest -OutFile` are unaffected
// by it. The bodies are also kept pure ASCII (see installScriptWin.js), so this
// is a second line of defence for injected values such as an IDN server URL.
const UTF8_BOM = '\ufeff';
function sendPs1(req, res, script, fileName) {
  noStore(res);
  res.status(200).type('text/plain; charset=utf-8');
  if (req.query.download) {
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  }
  res.send(UTF8_BOM + script);
}

// The build status with every error message replaced by a fixed pointer to
// the server log. Shape unchanged: `error`/`topError` stay null when there is
// no error, so a client that only tests them for truthiness keeps working.
const BUILD_ERROR_PUBLIC = 'build failed — see the server log for details';
function publicBinaryStatus(status) {
  const s = status && typeof status === 'object' ? status : {};
  const arches = {};
  for (const [arch, a] of Object.entries(s.arches || {})) {
    arches[arch] = a && a.error ? { ...a, error: BUILD_ERROR_PUBLIC } : a;
  }
  return { ...s, topError: s.topError ? BUILD_ERROR_PUBLIC : null, arches };
}

module.exports = { createEnrollRouter, resolveServerUrl, publicBinaryStatus };
