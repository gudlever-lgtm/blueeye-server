'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // last 24h when from/to omitted
const MAX_LIMIT = 500;

function parseTargetId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseDate(v) {
  if (v == null || v === '') return undefined; // omitted → caller applies default
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d; // null → invalid (→ 400)
}

// Per-target (per-agent) incident timeline.
//   GET /api/targets/:id/timeline?from=&to=&limit=   viewer+
// Merges anomaly findings, probe-outage incidents, agent connect/disconnect and
// remediation playbook runs into one chronological (newest-first) list. RBAC
// follows the existing viewer<operator<admin read convention (same as
// /api/incidents/:id/timeline). Read-only; no writes, no schema changes.
function createTargetsRouter({ agentsRepo, timelineService }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);

  router.get('/:id/timeline', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseTargetId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (from === null) return res.status(400).json({ error: 'from must be a valid date' });
    if (to === null) return res.status(400).json({ error: 'to must be a valid date' });

    let limit = MAX_LIMIT;
    if (req.query.limit !== undefined) {
      const n = Number.parseInt(req.query.limit, 10);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      limit = Math.min(n, MAX_LIMIT);
    }

    // Apply the default 24h window when a bound is omitted, then validate order.
    const toDate = to || new Date();
    const fromDate = from || new Date(toDate.getTime() - DEFAULT_WINDOW_MS);
    if (fromDate.getTime() > toDate.getTime()) {
      return res.status(400).json({ error: 'from must be before to' });
    }

    // Resolve the target BEFORE fan-out: an unknown agent is a clean 404 (not an
    // empty timeline), and a failure here is the only path to a real 500.
    const agent = await agentsRepo.findById(id);
    if (!agent) return res.status(404).json({ error: 'target not found' });

    const { events, partial, failedSources } = await timelineService.getTimeline(id, {
      from: fromDate, to: toDate, limit,
    });

    return res.json({
      events,
      partial,
      failedSources,
      window: { from: fromDate.toISOString(), to: toDate.toISOString() },
    });
  }));

  return router;
}

module.exports = { createTargetsRouter };
