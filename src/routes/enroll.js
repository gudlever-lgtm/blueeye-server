'use strict';

const fs = require('fs');
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { renderInstallScript } = require('../enroll/installScript');

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

// PUBLIC (unauthenticated) enrollment helpers, mounted at /enroll. A new agent
// has no token yet, so these must be reachable without auth:
//   GET /enroll/config              -> { serverUrl, certFingerprint }
//   GET /enroll/agent-source.tgz    -> the agent source bundle (built + run on the target)
//   GET /enroll/agent/:platform     -> a pre-built agent binary (legacy; only if published)
//   GET /enroll/:code/install.sh    -> the one-line installer for that code
function createEnrollRouter({ artifactStore, sourceStore, releaseStore, enrollmentCodesRepo, enrollConfig = {} }) {
  const router = express.Router();
  const certFingerprint = enrollConfig.certFingerprint || '';

  // Companion config so the binary can learn the server URL + fingerprint to pin
  // when they weren't embedded at install time.
  router.get('/config', (req, res) => {
    res.json({
      serverUrl: resolveServerUrl(req, enrollConfig),
      certFingerprint: certFingerprint || null,
    });
  });

  // Serve the agent SOURCE bundle (a gzipped tarball), packaged + checksummed at
  // startup. This is what the one-line installer downloads and then builds + runs
  // with Docker/Node — so no pre-built binaries are needed. 404 when no source is
  // configured (AGENT_SOURCE_DIR). The cached SHA-256 is exposed as a header.
  router.get('/agent-source.tgz', asyncHandler(async (req, res) => {
    const meta = sourceStore && sourceStore.meta();
    const buffer = sourceStore && sourceStore.buffer();
    if (!meta || !buffer) {
      return res.status(404).json({ error: 'No agent source published on this server' });
    }
    res.setHeader('Content-Type', meta.contentType);
    res.setHeader('Content-Length', meta.size);
    res.setHeader('X-Content-SHA256', meta.sha256);
    res.setHeader('Content-Disposition', `attachment; filename="${meta.filename}"`);
    res.status(200).send(buffer);
  }));

  // Latest SIGNED agent release — metadata only (JSON), so an agent can learn the
  // version/sha256/signature to verify against. 404 when no release is published.
  router.get('/agent-release', asyncHandler(async (req, res) => {
    const rel = releaseStore && typeof releaseStore.latest === 'function' ? releaseStore.latest() : null;
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
    if (!full || !full.buffer) {
      return res.status(404).json({ error: 'No signed agent release published on this server' });
    }
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', full.size);
    res.setHeader('X-Content-SHA256', full.sha256);
    res.setHeader('X-Release-Version', full.version);
    res.setHeader('X-Release-Signature', full.signature);
    res.setHeader('X-Release-Manifest', Buffer.from(JSON.stringify(full.manifest)).toString('base64'));
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
    res.status(200).type('text/x-shellscript; charset=utf-8').send(script);
  }));

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
    });
    res.status(200).type('text/x-shellscript; charset=utf-8').send(script);
  }));

  return router;
}

module.exports = { createEnrollRouter, resolveServerUrl };
