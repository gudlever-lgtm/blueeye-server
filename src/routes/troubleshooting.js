'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { MAX_WINDOW_MINUTES } = require('../troubleshooting/overviewService');

// The consolidated Troubleshooting Dashboard's single read endpoint. One
// request returns everything the view needs: key figures, the L2/L3 topology
// with per-node state, the correlated root causes with their blast radius, the
// flow-pair baseline deviations and the change timeline.
//
// RBAC — operator+. The underlying domains sit at three different levels
// (neighbors/graph/dependencies viewer+, changes/blast-radius/flow-baselines
// operator+, discovery admin). Aggregating must never WIDEN access, so the
// endpoint adopts the strictest non-admin level its data requires, and the
// admin-only discovery candidates are included only for admins — as an empty
// list for everyone else, not a 403 that would deny the whole screen.
//
// Read-only: nothing here pushes an agent command, so no signed command and no
// audit write. Adding an action later means an Ed25519-signed command over
// agentCommander plus a hash-chained audit entry, as the evidence path does.
function createTroubleshootingRouter({ overviewService = null } = {}) {
  const router = express.Router();
  const reader = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  // GET /api/troubleshooting/overview?minutes=&limit=
  //   400 invalid query · 401 unauthenticated · 403 viewer
  //   503 when the aggregation service is not wired · 500 on an unexpected fault
  router.get('/overview', requireAuth, reader, asyncHandler(async (req, res) => {
    if (!overviewService || typeof overviewService.getOverview !== 'function') {
      return res.status(503).json({ error: 'Troubleshooting overview is not available' });
    }

    let windowMinutes;
    if (req.query.minutes !== undefined && req.query.minutes !== '') {
      windowMinutes = Number(req.query.minutes);
      if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > MAX_WINDOW_MINUTES) {
        return res.status(400).json({ error: `minutes must be 1..${MAX_WINDOW_MINUTES}` });
      }
    }

    let limit;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return res.status(400).json({ error: 'limit must be 1..1000' });
      }
    }

    const overview = await overviewService.getOverview({
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
      ...(limit !== undefined ? { clusterLimit: limit, anomalyLimit: limit, timelineLimit: limit } : {}),
      includeDiscovery: req.user && req.user.role === ROLES.ADMIN,
    });

    return res.json(overview);
  }));

  return router;
}

module.exports = { createTroubleshootingRouter };
