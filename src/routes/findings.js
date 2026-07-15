'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { isChangeEvent } = require('../timeline/targetTimeline');

const DEFAULT_CONTEXT_MINUTES = 30;
const MAX_CONTEXT_MINUTES = 24 * 60; // cap the look-back at 24h
const CONTEXT_LIMIT = 500;

// Analysis findings API (staff, user-JWT). Reuses the existing auth middleware.
// Mounted at /api/findings. `timelineService` is optional: when absent the
// "what changed before this" endpoint is simply not mounted.
function createFindingsRouter({ findingStore, timelineService = null }) {
  const router = express.Router();

  // GET /api/findings?hostId=&since= — list findings (viewer+).
  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const hostId = req.query.hostId ? String(req.query.hostId) : undefined;
      let since;
      if (req.query.since) {
        const d = new Date(req.query.since);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ error: 'Validation failed', details: { since: 'since must be a valid date' } });
        }
        since = d;
      }
      let limit = 500;
      if (req.query.limit !== undefined) {
        const n = Number.parseInt(req.query.limit, 10);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: 'Validation failed', details: { limit: 'limit must be a positive integer' } });
        }
        limit = Math.min(n, 500);
      }
      res.json(await findingStore.list(hostId, since, limit));
    })
  );

  // GET /api/findings/:id/context?window=<minutes> — "what changed before this"
  // (Phase 3, viewer+). Returns the CHANGE-type timeline events on the finding's
  // device in the window immediately before its trigger timestamp
  // (findings.created_at). Reuses the Phase 1 timeline merge, filtered to changes
  // — not a separate query path. Chronological, closest-to-trigger first.
  if (timelineService && typeof timelineService.getTimeline === 'function') {
    router.get(
      '/:id/context',
      requireAuth,
      requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
      asyncHandler(async (req, res) => {
        const id = String(req.params.id || ''); // finding ids are UUIDs

        let minutes = DEFAULT_CONTEXT_MINUTES;
        if (req.query.window !== undefined) {
          const n = Number.parseInt(req.query.window, 10);
          if (!Number.isInteger(n) || n < 1 || n > MAX_CONTEXT_MINUTES) {
            return res.status(400).json({ error: `window must be an integer 1..${MAX_CONTEXT_MINUTES} (minutes)` });
          }
          minutes = n;
        }

        const finding = await findingStore.get(id);
        if (!finding) return res.status(404).json({ error: 'finding not found' });

        // The trigger timestamp is the finding's created_at (detection time).
        const triggerAt = finding.createdAt ? new Date(finding.createdAt) : null;
        const agentId = Number(finding.hostId);
        // A finding with no usable timestamp or a non-numeric host can't be
        // correlated — that's an empty result, not an error (like the timeline).
        if (!triggerAt || Number.isNaN(triggerAt.getTime()) || !Number.isInteger(agentId)) {
          return res.json({ changes: [], partial: false, failedSources: [], trigger: { findingId: id, at: null }, window: { minutes } });
        }

        const from = new Date(triggerAt.getTime() - minutes * 60 * 1000);
        const { events, partial, failedSources } = await timelineService.getTimeline(agentId, {
          from, to: triggerAt, limit: CONTEXT_LIMIT,
        });
        // Change-type only. The finding itself is a symptom, so it's excluded.
        const changes = events.filter(isChangeEvent);

        return res.json({
          changes,
          partial,
          failedSources,
          trigger: { findingId: id, at: triggerAt.toISOString() },
          window: { from: from.toISOString(), to: triggerAt.toISOString(), minutes },
        });
      })
    );
  }

  // POST /api/findings/:id/ack — acknowledge a finding (operator/admin).
  // 404 when the id is unknown; the server's error handler covers 500.
  router.post(
    '/:id/ack',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      // finding ids are UUIDs, so don't use the numeric parseId here.
      const id = String(req.params.id || '');
      const ok = await findingStore.ack(id);
      if (!ok) {
        return res.status(404).json({ error: 'Finding not found' });
      }
      res.json({ id, acked: true });
    })
  );

  return router;
}

module.exports = { createFindingsRouter };
