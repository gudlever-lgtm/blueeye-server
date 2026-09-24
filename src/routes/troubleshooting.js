'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { MAX_WINDOW_MINUTES, MAX_FAULT_PAGE } = require('../troubleshooting/overviewService');

// Where a fault's root cause comes from: a cross-agent situation or an open
// event case (src/troubleshooting/overviewService.js).
const FAULT_SOURCES = ['cluster', 'case'];

// The consolidated Troubleshooting Dashboard's single read endpoint. One
// request returns everything the view needs: key figures, the L2/L3 topology
// with per-node state, the correlated root causes with their blast radius, the
// flow-pair baseline deviations and the change timeline.
//
// RBAC — viewer+, filtered by role. The underlying domains sit at three
// different levels (neighbors/graph/dependencies/clusters/findings viewer+,
// changes/blast-radius/flow-baselines operator+, discovery admin). Aggregating
// must never WIDEN access, so each domain is included only for the roles that
// may read it on its own: a viewer gets the root causes, the topology and the
// agent events, with the operator domains empty and named in `restricted`;
// discovery candidates are admin-only. Empty, not a 403: the first-line person
// on the phone needs "what is broken now" as much as the operator does.
//
// Read-only: nothing here pushes an agent command, so no signed command and no
// audit write. Adding an action later means an Ed25519-signed command over
// agentCommander plus a hash-chained audit entry, as the evidence path does.
function createTroubleshootingRouter({ overviewService = null } = {}) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);

  // GET /api/troubleshooting/overview?minutes=&limit=
  //   400 invalid query · 401 unauthenticated · 403 no recognised role
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
      ...(limit !== undefined ? {
        clusterLimit: limit, caseLimit: limit, anomalyLimit: limit, timelineLimit: limit,
      } : {}),
      includeDiscovery: req.user && req.user.role === ROLES.ADMIN,
      includeOperatorData: !!(req.user && (req.user.role === ROLES.OPERATOR || req.user.role === ROLES.ADMIN)),
    });

    return res.json(overview);
  }));

  // GET /api/troubleshooting/faults?limit=&offset=&clusterId=&caseId=&source=
  //   The RAW alarms behind the live root causes — the "Active faults" figure
  //   expanded into rows. Deliberately a SEPARATE read: the overview above never
  //   fetches these, so opening the Troubleshooting screen costs one rollup and
  //   not tens of thousands of finding rows. The dashboard calls this only when
  //   the operator asks to list them, and pages through it.
  //
  //   Same RBAC as the overview (viewer+) over the same source — the finding
  //   rows are viewer+ under /api/findings too, and the event cases under
  //   /api/events — so this widens nothing: it is the detail of a number the
  //   overview already shows.
  //
  //   A root cause is a live situation (`clusterId`) or an open event case
  //   (`caseId`); every row carries `source: 'cluster'|'case'`. The two
  //   filters name different records, so both at once is a 400, and so is a
  //   `source` that contradicts the one given.
  //
  //   400 invalid query · 401 unauthenticated · 403 no recognised role
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

    let caseId;
    if (req.query.caseId !== undefined && req.query.caseId !== '') {
      caseId = Number(req.query.caseId);
      if (!Number.isInteger(caseId) || caseId < 1) {
        return res.status(400).json({ error: 'caseId must be a positive integer' });
      }
    }
    if (clusterId !== undefined && caseId !== undefined) {
      return res.status(400).json({ error: 'clusterId and caseId cannot be combined' });
    }

    let source;
    if (req.query.source !== undefined && req.query.source !== '') {
      source = String(req.query.source);
      if (!FAULT_SOURCES.includes(source)) {
        return res.status(400).json({ error: `source must be one of ${FAULT_SOURCES.join(', ')}` });
      }
      if ((source === 'case' && clusterId !== undefined) || (source === 'cluster' && caseId !== undefined)) {
        return res.status(400).json({ error: 'source contradicts the clusterId/caseId filter' });
      }
    }

    const page = await overviewService.getFaults({
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(clusterId !== undefined ? { clusterId } : {}),
      ...(caseId !== undefined ? { caseId } : {}),
      ...(source !== undefined ? { source } : {}),
    });

    return res.json(page);
  }));

  return router;
}

module.exports = { createTroubleshootingRouter };
