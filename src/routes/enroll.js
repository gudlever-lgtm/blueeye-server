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
//   GET /enroll/config            -> { serverUrl, certFingerprint }
//   GET /enroll/agent/:platform   -> the agent binary (served from the server)
//   GET /enroll/:code/install.sh  -> the one-line installer for that code
function createEnrollRouter({ artifactStore, enrollmentCodesRepo, enrollConfig = {} }) {
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

  // Serve the agent binary for a platform from the local artifacts dir. 404 for
  // an unknown/unpublished platform. The cached SHA-256 is exposed as a header
  // so a client can verify out-of-band.
  router.get('/agent/:platform', asyncHandler(async (req, res) => {
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
      checksums: artifactStore.checksums(),
    });
    res.status(200).type('text/x-shellscript; charset=utf-8').send(script);
  }));

  return router;
}

module.exports = { createEnrollRouter, resolveServerUrl };
