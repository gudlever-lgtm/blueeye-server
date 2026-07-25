'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { isChangeEvent } = require('../timeline/targetTimeline');

const DEFAULT_CONTEXT_MINUTES = 30;
const MAX_CONTEXT_MINUTES = 24 * 60; // cap the look-back at 24h
const CONTEXT_LIMIT = 500;
const SEVERITIES = ['INFO', 'WARN', 'CRIT'];

// Parses the shared list/summary filters (hostId/severity/metric/since) off the
// query string. Returns { filters } on success or { error } (a 400 message) so
// both endpoints validate identically.
function parseListFilters(query) {
  const filters = {};
  if (query.hostId) filters.hostId = String(query.hostId);
  if (query.severity !== undefined) {
    if (!SEVERITIES.includes(query.severity)) {
      return { error: { severity: `severity must be one of ${SEVERITIES.join(', ')}` } };
    }
    filters.severity = String(query.severity);
  }
  if (query.metric !== undefined && query.metric !== '') filters.metric = String(query.metric);
  if (query.since) {
    const d = new Date(query.since);
    if (Number.isNaN(d.getTime())) return { error: { since: 'since must be a valid date' } };
    filters.since = d;
  }
  return { filters };
}

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
      const parsed = parseListFilters(req.query);
      if (parsed.error) {
        return res.status(400).json({ error: 'Validation failed', details: parsed.error });
      }
      const { hostId, since, severity, metric } = parsed.filters;
      let limit = 500;
      if (req.query.limit !== undefined) {
        const n = Number.parseInt(req.query.limit, 10);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: 'Validation failed', details: { limit: 'limit must be a positive integer' } });
        }
        limit = Math.min(n, 500);
      }
      res.json(await findingStore.list(hostId, since, limit, undefined, { severity, metric }));
    })
  );

  // GET /api/findings/summary — aggregated overview (counts + robust deviation
  // stats) grouped by severity / metric / host, over the same filter set as the
  // list. Backs the Analysis page's overview panel + its metric filter options.
  router.get(
    '/summary',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const parsed = parseListFilters(req.query);
      if (parsed.error) {
        return res.status(400).json({ error: 'Validation failed', details: parsed.error });
      }
      res.json(await findingStore.summary(parsed.filters));
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

        const detectedAt = finding.createdAt ? new Date(finding.createdAt) : null;
        const detectedValid = detectedAt && !Number.isNaN(detectedAt.getTime());
        // Anchor the look-back on anomaly ONSET (findings.window_from) when it
        // exists — the change that caused an anomaly precedes its onset, which
        // can be well before detection for a slow-to-fire finding. Fall back to
        // detection time (created_at) otherwise.
        const win = Array.isArray(finding.window) ? finding.window : [];
        const onset = win[0] ? new Date(win[0]) : null;
        const onsetValid = onset && !Number.isNaN(onset.getTime());
        const anchorAt = onsetValid ? onset : (detectedValid ? detectedAt : null);
        const agentId = Number(finding.hostId);

        // A finding with no usable timestamp or a non-numeric host can't be
        // correlated — that's an empty result, not an error (like the timeline).
        if (!anchorAt || !Number.isInteger(agentId)) {
          return res.json({
            changes: [], partial: false, failedSources: [],
            trigger: { findingId: id, at: detectedValid ? detectedAt.toISOString() : null },
            window: { minutes },
          });
        }

        const from = new Date(anchorAt.getTime() - minutes * 60 * 1000);
        const { events, partial, failedSources } = await timelineService.getTimeline(agentId, {
          from, to: anchorAt, limit: CONTEXT_LIMIT,
        });
        // Change-type only. The finding itself is a symptom, so it's excluded.
        const changes = events.filter(isChangeEvent);

        return res.json({
          changes,
          partial,
          failedSources,
          trigger: { findingId: id, at: detectedValid ? detectedAt.toISOString() : null },
          window: { from: from.toISOString(), to: anchorAt.toISOString(), minutes, anchoredOn: onsetValid ? 'onset' : 'detection' },
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
