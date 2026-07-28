'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// Read-only baseline context for the dashboard (Fase 4).
//
// "300 Mbit" means nothing. "220% above normal for a Tuesday at 14:00" means
// something. This serves the second half — the day-of-week/hour-of-day baseline
// a metric is compared against — so the shared UI component can annotate a
// number without every view fetching it its own way.
//
// SCOPE, honestly stated: the ONLY dimension this can serve today is per-flow-
// pair traffic VOLUME (`flow_pair_baselines`, migration 068). See
// docs/baseline-context.md for what is missing and why:
//   * per interface — interfaces are not a persisted entity in this codebase
//   * latency/loss/jitter — the metric baselines in src/analysis/baselines.js are
//     a disk file keyed by UTC hour with no day-of-week dimension and no API
// Rather than approximate either, this endpoint serves what exists and the
// component renders NOTHING where no baseline exists.
//
// RBAC: viewer+. The data is per-(src,dst,port) traffic volume, the same class
// of metadata a viewer already reads in the Flows explorer — so this is not a
// widening, it is the same data with a comparison attached. The operator+
// `/api/topology/flow-baselines` route is left alone: it sits next to the
// recompute POST and is a diagnostic surface, not a display one.

const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 500;

function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function createBaselinesRouter({ flowPairBaselinesRepo = null, agentsRepo = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);

  // GET /api/baselines/flow-pair?host=<agentId>&limit=
  //
  // The host's outbound flow-pair baselines, keyed by (dst, port, dow, hour).
  // Each row carries `observationCount` and `updatedAt` so the UI can show the
  // baseline's AGE on hover — a baseline built from three days of data is not
  // the same claim as one built from three months, and the technician deciding
  // whether to act on "220% above normal" needs to know which they are looking
  // at.
  router.get('/flow-pair', requireAuth, reader, asyncHandler(async (req, res) => {
    if (!flowPairBaselinesRepo || typeof flowPairBaselinesRepo.listForHost !== 'function') {
      return res.status(503).json({ error: 'Flow-pair baselines are not available' });
    }

    const hostId = parseId(req.query.host);
    if (hostId === null) return res.status(400).json({ error: 'host is required (a positive agent id)' });

    let limit = DEFAULT_LIMIT;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must be an integer 1..${MAX_LIMIT}` });
      }
    }

    if (agentsRepo && typeof agentsRepo.findById === 'function' && !(await agentsRepo.findById(hostId))) {
      return res.status(404).json({ error: 'Host not found' });
    }

    const baselines = await flowPairBaselinesRepo.listForHost({ hostId, limit });

    // An empty list is 200, not 404: on a fresh install flow_pair_baselines is
    // empty for the first ~14 days (history builds FORWARD — raw flows cannot be
    // backfilled), and "no baseline yet" is a normal state the UI must render as
    // "no secondary line", not as an error.
    return res.json({
      host: hostId,
      baselines,
      // Named so the UI can say WHY there is no context, rather than leaving the
      // technician to wonder whether the page is broken.
      building: baselines.length === 0,
    });
  }));

  return router;
}

module.exports = { createBaselinesRouter, MAX_LIMIT, DEFAULT_LIMIT };
