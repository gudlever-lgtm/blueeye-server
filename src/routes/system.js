'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const pkg = require('../../package.json');

// Server storage info (disk free/used + database size). Read-only, viewer+.
function createSystemRouter({ systemInfo, agentSourceStore, agentBinaryStore, releaseStore } = {}) {
  const router = express.Router();

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
      res.json({
        server: pkg.version || null,
        releaseDate: pkg.releaseDate || null,
        agent: offeredAgentVersion(),
        agentSource: sourceAgentVersion(),
        binaryBuild: agentBinaryStore ? agentBinaryStore.status() : null,
      });
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
      res.json({
        version: typeof agentSourceStore.sourceVersion === 'function' ? agentSourceStore.sourceVersion() : null,
        available: typeof agentSourceStore.available === 'function' ? agentSourceStore.available() : false,
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
