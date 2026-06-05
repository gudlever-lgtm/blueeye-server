'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const pkg = require('../../package.json');

// Server storage info (disk free/used + database size). Read-only, viewer+.
function createSystemRouter({ systemInfo, agentSourceStore } = {}) {
  const router = express.Router();

  // Versions, for the Settings "Updates" panel: this server's version and the
  // agent version it serves (so the UI can flag out-of-date agents). viewer+.
  router.get(
    '/version',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    (req, res) => {
      res.json({
        server: pkg.version || null,
        agent: agentSourceStore ? agentSourceStore.sourceVersion() : null,
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
