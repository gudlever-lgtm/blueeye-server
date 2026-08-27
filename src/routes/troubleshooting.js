'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { MAX_WINDOW_MINUTES, MAX_FAULT_PAGE } = require('../troubleshooting/overviewService');

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

  // GET /api/troubleshooting/faults?limit=&offset=&clusterId=
  //   The RAW alarms behind the live root causes — the "Active faults" figure
  //   expanded into rows. Deliberately a SEPARATE read: the overview above never
  //   fetches these, so opening the Troubleshooting screen costs one rollup and
  //   not tens of thousands of finding rows. The dashboard calls this only when
  //   the operator asks to list them, and pages through it.
  //
  //   Same RBAC as the overview (operator+) over the same source, so this widens
  //   nothing: it is the detail of a number the overview already shows.
  //
  //   400 invalid query · 401 unauthenticated · 403 viewer
  //   503 when the aggregation service is not wired · 500 on an unexpected fault
  router.get('/faults', requireAuth, reader, asyncHandler(async (req, res) => {
    if (!overviewService || typeof overviewService.getFaults !== 'function') {
      return res.status(503).json({ error: 'Troubleshooting overview is not available' });
    }

    let limit;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FAULT_PAGE) {
        return res.status(400).json({ error: `limit must be 1..${MAX_FAULT_PAGE}` });
      }
    }

    let offset;
    if (req.query.offset !== undefined && req.query.offset !== '') {
      offset = Number(req.query.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be >= 0' });
      }
    }

    let clusterId;
    if (req.query.clusterId !== undefined && req.query.clusterId !== '') {
      clusterId = Number(req.query.clusterId);
      if (!Number.isInteger(clusterId) || clusterId < 1) {
        return res.status(400).json({ error: 'clusterId must be a positive integer' });
      }
    }

    const page = await overviewService.getFaults({
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(clusterId !== undefined ? { clusterId } : {}),
    });

    return res.json(page);
  }));

  return router;
}

module.exports = { createTroubleshootingRouter };
