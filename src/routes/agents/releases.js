'use strict';

const crypto = require('crypto');
const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../../auth/middleware');
const { ROLES } = require('../../auth/roles');
const { verifyProof } = require('../../license/verify');

// Signed agent release artefacts. The server VERIFIES the Ed25519 signature and
// the tarball hash before storing anything, so only authentic builds can ever
// become something an operator is able to push to a fleet.
function createAgentReleasesRouter(ctx) {
  const router = express.Router();
  const { releaseStore, releasePublicKey, releaseKeyService, auditLogger } = ctx;

  // POST /agents/releases — upload a SIGNED agent release tarball (admin). The
  // server VERIFIES the Ed25519 signature over the release manifest AND that the
  // tarball's sha256 matches that (signed) manifest BEFORE storing it — so only
  // authentic, untampered builds ever become available to push to agents. The
  // tarball is the raw request body (application/octet-stream, so it bypasses the
  // 1 MB JSON limit); the manifest + signature + version ride in headers:
  //   X-Release-Version    e.g. 0.3.0
  //   X-Release-Manifest   base64(JSON) of { version, sha256, size, ... } — the SIGNED bytes
  //   X-Release-Signature  base64 Ed25519 signature over the canonical manifest
  router.post(
    '/releases',
    requireAuth,
    requireRole(ROLES.ADMIN),
    express.raw({ type: 'application/octet-stream', limit: '64mb' }),
    asyncHandler(async (req, res) => {
      if (!releaseStore || typeof releaseStore.add !== 'function') {
        return res.status(503).json({ error: 'Release store not available' });
      }
      // releasePublicKey may be a live resolver (managed key, changeable at runtime)
      // or a plain string (tests / env key).
      const releaseKey = (typeof releasePublicKey === 'function' ? releasePublicKey() : releasePublicKey) || '';
      if (!releaseKey) {
        return res.status(503).json({ error: 'Agent release public key not configured' });
      }
      const tarball = Buffer.isBuffer(req.body) ? req.body : null;
      if (!tarball || tarball.length === 0) {
        return res.status(400).json({ error: 'Empty body — POST the gzipped tarball as application/octet-stream' });
      }
      const version = String(req.get('X-Release-Version') || '').trim();
      const signature = String(req.get('X-Release-Signature') || '').trim();
      let manifest = null;
      try {
        manifest = JSON.parse(Buffer.from(String(req.get('X-Release-Manifest') || ''), 'base64').toString('utf8'));
      } catch {
        manifest = null;
      }
      if (!version || !signature || !manifest || typeof manifest !== 'object') {
        return res.status(400).json({ error: 'Missing or invalid X-Release-Version / X-Release-Signature / X-Release-Manifest' });
      }
      if (manifest.version !== version) {
        return res.status(400).json({ error: 'Manifest version does not match X-Release-Version' });
      }
      // 1) Authenticity: Ed25519 signature over the canonical manifest (reuses the
      //    exact license-proof verifier — a different, release-only public key).
      if (!verifyProof(manifest, signature, releaseKey)) {
        return res.status(422).json({ error: 'Release signature did not verify' });
      }
      // 2) Integrity: the uploaded bytes must match the sha256 the signed manifest binds.
      const sha256 = crypto.createHash('sha256').update(tarball).digest('hex');
      if (manifest.sha256 !== sha256) {
        return res.status(422).json({ error: 'Tarball sha256 does not match the signed manifest' });
      }
      if (Number.isInteger(manifest.size) && manifest.size !== tarball.length) {
        return res.status(422).json({ error: 'Tarball size does not match the signed manifest' });
      }
      const uploadedBy = (req.user && (req.user.id || req.user.sub)) || null;
      const meta = releaseStore.add({ version, buffer: tarball, sha256, size: tarball.length, signature, manifest, uploadedBy });
      res.status(201).json({ version: meta.version, sha256: meta.sha256, size: meta.size, createdAt: meta.createdAt });
    })
  );

  // POST /agents/:id/ping — liveness check: asks the connected agent to reply
  // over the WebSocket and reports the round-trip time + the agent's live
  // version/sources. viewer+ (no side effects). 409 if the agent isn't connected.

  return router;
}

module.exports = { createAgentReleasesRouter };
