'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const pkg = require('../../package.json');

// Server storage info (disk free/used + database size). Read-only, viewer+.
function createSystemRouter({ systemInfo, agentSourceStore, agentBinaryStore, releaseStore, releaseKeyService = null, publishRelease = null } = {}) {
  const router = express.Router();

  // The latest SIGNED release the server can push for a one-click Update. When
  // this is null the update command goes out UNSIGNED (source bundle only), which
  // an agent that pinned a release key refuses ("signature downgrade") — so the
  // UI needs to know whether a signed release exists, and whether the server can
  // mint one, to explain why one-click updates fail and offer a fix.
  const latestRelease = () =>
    (releaseStore && typeof releaseStore.latest === 'function' ? releaseStore.latest() : null);
  const canSignReleases = () =>
    !!(releaseKeyService && typeof releaseKeyService.canSign === 'function' && releaseKeyService.canSign());
  const keyConfigured = () =>
    !!(releaseKeyService && typeof releaseKeyService.isConfigured === 'function' && releaseKeyService.isConfigured());

  // The startup-packaged agent SOURCE bundle version. This is what the one-line
  // installer and the Windows/enrollment path actually download
  // (GET /enroll/agent-source.tgz), so it's the newest version a non-systemd
  // agent (Docker/Windows/unmanaged) can reach by re-running its installer.
  const sourceAgentVersion = () =>
    (agentSourceStore && typeof agentSourceStore.sourceVersion === 'function' ? agentSourceStore.sourceVersion() : null);

  // The agent version the server currently offers: a signed, uploaded release
  // takes precedence over the startup-packaged source bundle, so "is this agent
  // out of date?" tracks what a systemd one-click Update would actually push.
  const offeredAgentVersion = () => {
    const rel = releaseStore && typeof releaseStore.latest === 'function' ? releaseStore.latest() : null;
    if (rel && rel.version) return rel.version;
    return sourceAgentVersion();
  };

  // Versions, for the Settings "Updates" panel: this server's version and the
  // agent versions it serves (so the UI can flag out-of-date agents). `agent` is
  // what a systemd one-click Update pushes (signed release, else source); when a
  // signed release is newer than the packaged source these diverge, and
  // `agentSource` is what installer-based agents can actually reach — the UI
  // compares those two against the right target. viewer+.
  router.get(
    '/version',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const rel = latestRelease();
      res.json({
        server: pkg.version || null,
        releaseDate: pkg.releaseDate || null,
        agent: offeredAgentVersion(),
        agentSource: sourceAgentVersion(),
        // Signing status, so the UI can explain a stuck one-click update: a
        // one-click Update is only accepted by key-pinning agents when a SIGNED
        // release exists. `agentReleaseVersion` is that release (null = none, so
        // the update would go out unsigned and be refused); `canSignReleases`
        // says whether the server can publish one now; `agentKeyConfigured` says
        // whether any signing key exists at all.
        agentReleaseVersion: rel && rel.version ? rel.version : null,
        canSignReleases: canSignReleases(),
        agentKeyConfigured: keyConfigured(),
        binaryBuild: agentBinaryStore ? agentBinaryStore.status() : null,
      });
    })
  );

  // Sign the CURRENT source bundle into a signed release and publish it, so
  // one-click Updates start working for agents that pin a release key. admin
  // only. Fails with a clear reason when the server has no key that can sign.
  router.post(
    '/agent-release/publish',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (typeof publishRelease !== 'function') {
        return res.status(503).json({ error: 'Release publishing is not available on this server' });
      }
      if (!canSignReleases()) {
        return res.status(409).json({
          error: keyConfigured()
            ? 'The agent signing key is verify-only (it has no private key on this server), so it cannot publish a signed release. Generate a managed signing key under Settings → Agent key.'
            : 'No agent signing key is configured, so a signed release cannot be published. Generate one under Settings → Agent key first.',
          canSign: false,
          keyConfigured: keyConfigured(),
        });
      }
      const meta = await publishRelease();
      if (!meta || !meta.version) {
        return res.status(500).json({ error: 'Could not publish a signed release (no agent source bundle to sign?)' });
      }
      res.json({ version: meta.version, sha256: meta.sha256 || null, signed: true });
    })
  );

  // Re-package the agent source bundle from disk (AGENT_SOURCE_DIR) without
  // restarting the server, so a freshly-pulled agent version is served right
  // away and out-of-date agents get flagged/updated. admin only.
  router.post(
    '/agent-source/reload',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!agentSourceStore || typeof agentSourceStore.reload !== 'function') {
        return res.status(503).json({ error: 'Agent source not configured on this server' });
      }
      await agentSourceStore.reload();
      // Kick off a binary rebuild for the new source version (non-blocking).
      if (agentBinaryStore && typeof agentBinaryStore.reload === 'function') {
        agentBinaryStore.reload();
      }
      // Re-sign the freshly-reloaded source into a signed release too, so a
      // one-click Update tracks the new version instead of pushing an unsigned
      // (and therefore refused) bundle. Best-effort + no-op without a signing
      // key — reloading source must still succeed.
      let released = null;
      if (typeof publishRelease === 'function' && canSignReleases()) {
        try { const meta = await publishRelease(); released = meta && meta.version ? meta.version : null; } catch { /* keep reload successful */ }
      }
      res.json({
        version: typeof agentSourceStore.sourceVersion === 'function' ? agentSourceStore.sourceVersion() : null,
        available: typeof agentSourceStore.available === 'function' ? agentSourceStore.available() : false,
        releaseVersion: released,
      });
    })
  );

  router.get(
    '/storage',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!systemInfo) {
        return res.status(503).json({ error: 'System info not available' });
      }
      res.json(await systemInfo.getStorage());
    })
  );

  return router;
}

module.exports = { createSystemRouter };
