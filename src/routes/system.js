'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const pkg = require('../../package.json');

// Server storage info (disk free/used + database size). Read-only, viewer+.
function createSystemRouter({ systemInfo, agentSourceStore, releaseStore } = {}) {
  const router = express.Router();

  // The agent version the server currently offers: a signed, uploaded release
  // takes precedence over the startup-packaged source bundle, so "is this agent
  // out of date?" tracks what the Update button would actually push.
  const offeredAgentVersion = () => {
    const rel = releaseStore && typeof releaseStore.latest === 'function' ? releaseStore.latest() : null;
    if (rel && rel.version) return rel.version;
    return agentSourceStore && typeof agentSourceStore.sourceVersion === 'function' ? agentSourceStore.sourceVersion() : null;
  };

  // Versions, for the Settings "Updates" panel: this server's version and the
  // agent version it serves (so the UI can flag out-of-date agents). viewer+.
  router.get(
    '/version',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    (req, res) => {
      res.json({
        server: pkg.version || null,
        agent: offeredAgentVersion(),
      });
    }
  );

  // Re-package the agent source bundle from disk (AGENT_SOURCE_DIR) without
  // restarting the server, so a freshly-pulled agent version is served right
  // away and out-of-date agents get flagged/updated. admin only.
  router.post(
    '/agent-source/reload',
    requireAuth,
    requireRole(ROLES.ADMIN),
    (req, res) => {
      if (!agentSourceStore || typeof agentSourceStore.reload !== 'function') {
        return res.status(503).json({ error: 'Agent source not configured on this server' });
      }
      agentSourceStore.reload();
      res.json({
        version: typeof agentSourceStore.sourceVersion === 'function' ? agentSourceStore.sourceVersion() : null,
        available: typeof agentSourceStore.available === 'function' ? agentSourceStore.available() : false,
      });
    }
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
