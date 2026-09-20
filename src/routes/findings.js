'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { buildNetworkReport, renderNetworkReportHtml } = require('../analysis/networkReport');
const { isChangeEvent } = require('../timeline/targetTimeline');

const DEFAULT_CONTEXT_MINUTES = 30;
const MAX_CONTEXT_MINUTES = 24 * 60; // cap the look-back at 24h
const CONTEXT_LIMIT = 500;
const SEVERITIES = ['INFO', 'WARN', 'CRIT'];

// Parses the shared list/summary filters (hostId/severity/metric/since) off the
// query string. Returns { filters } on success or { error } (a 400 message) so
// both endpoints validate identically.
// How many ids one selection may carry. Past this the honest answer is a
// filter, not a list: the browser is not sending ten thousand UUIDs, and a
// query that did would be slower than the UPDATE it is asking for.
const MAX_ACK_IDS = 1000;

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
  // A switch, and a port on it (migration 110). Both NARROW the host filter
  // rather than replacing it: a finding about a port carries the polling agent
  // in hostId too, so "everything on this agent" still includes the switches
  // it polls.
  for (const key of ['deviceId', 'interfaceId']) {
    if (query[key] === undefined || query[key] === '') continue;
    const n = Number(query[key]);
    if (!Number.isInteger(n) || n < 1) {
      return { error: { [key]: `${key} must be a positive integer` } };
    }
    filters[key] = n;
  }
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
// `auditLogger` is optional so an older wiring keeps working, but a bulk accept
// is exactly the action that needs a record: one request can retire a hundred
// thousand findings, and afterwards the only evidence it was deliberate is the
// hash-chained log.
function createFindingsRouter({ findingStore, timelineService = null, auditLogger = null, agentsRepo = null }) {
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
      const { hostId, since, severity, metric, deviceId, interfaceId } = parsed.filters;
      let limit = 500;
      if (req.query.limit !== undefined) {
        const n = Number.parseInt(req.query.limit, 10);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: 'Validation failed', details: { limit: 'limit must be a positive integer' } });
        }
        limit = Math.min(n, 500);
      }
      res.json(await findingStore.list(hostId, since, limit, undefined, {
        severity, metric, deviceId, interfaceId,
      }));
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

  // GET /api/findings/trend — findings over time, bucketed, for the reporting
  // charts. Same filter set as the list and the summary.
  //
  // The BUCKET is explicit, not inferred from the range: hourly over ninety
  // days is 2 160 points for a chart 760 pixels wide, and daily over one day is
  // a single bar. The caller picks and the answer says which it got, so a chart
  // never silently redraws at a different resolution than its axis claims.
  router.get(
    '/trend',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (typeof findingStore.trend !== 'function') {
        return res.status(404).json({ error: 'Trends are not available' });
      }
      const parsed = parseListFilters(req.query);
      if (parsed.error) {
        return res.status(400).json({ error: 'Validation failed', details: parsed.error });
      }
      const bucket = req.query.bucket === undefined || req.query.bucket === '' ? 'day' : String(req.query.bucket);
      if (!['hour', 'day'].includes(bucket)) {
        return res.status(400).json({ error: 'bucket must be hour or day' });
      }
      const points = await findingStore.trend({ ...parsed.filters, bucket });
      res.json({ bucket, points, filters: parsed.filters });
    })
  );

  // GET /api/findings/report — the executive network report: "fix these
  // specific issues at these specific locations".
  //
  // Rendered with the NIS2 document chrome (src/nis2/report.js) rather than a
  // second report engine, and DETERMINISTIC: every number is computed here and
  // every sentence is assembled from those numbers. A report a manager forwards
  // to an engineer has to be defensible line by line, and "the assistant said
  // so" is not that.
  //
  // `Accept: text/html` (or ?format=html) downloads the document; otherwise the
  // structured report comes back as JSON, so it can be scheduled, diffed or
  // fed somewhere else.
  router.get(
    '/report',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const daysRaw = req.query.days === undefined || req.query.days === '' ? 30 : Number(req.query.days);
      if (!Number.isInteger(daysRaw) || daysRaw < 1 || daysRaw > 365) {
        return res.status(400).json({ error: 'days must be between 1 and 365' });
      }
      const since = new Date(Date.now() - daysRaw * 24 * 60 * 60 * 1000);
      const locale = req.query.locale === 'da' ? 'da' : 'en';

      const summary = await findingStore.summary({ since });
      const trend = typeof findingStore.trend === 'function'
        ? await findingStore.trend({ since, bucket: daysRaw <= 2 ? 'hour' : 'day' })
        : [];

      // Agent id → name, and its site. "host 30" in a document somebody
      // forwards is a number nobody outside this room can act on.
      const names = new Map();
      const sites = new Map();
      if (agentsRepo && typeof agentsRepo.findAll === 'function') {
        try {
          for (const a of await agentsRepo.findAll()) {
            names.set(String(a.id), a.display_name || a.hostname || String(a.id));
            if (a.location_name || a.locationName) sites.set(String(a.id), a.location_name || a.locationName);
          }
        } catch { /* a name is a nicety; the report still states the numbers */ }
      }

      const report = buildNetworkReport({
        summary,
        trend,
        hostName: (id) => names.get(String(id)) || `#${id}`,
        locationOf: (id) => sites.get(String(id)) || null,
        periodDays: daysRaw,
        locale,
      });

      const wantsHtml = req.query.format === 'html'
        || (req.get('accept') || '').includes('text/html');
      if (!wantsHtml) return res.json({ report });

      const html = renderNetworkReportHtml(report, { org: req.query.org || undefined, locale });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="network-status-${new Date().toISOString().slice(0, 10)}.html"`);
      return res.send(html);
    })
  );

  // POST /api/findings/ack — "I have seen these and I accept them", for many
  // findings at once (operator/admin).
  //
  // One at a time does not survive contact with the numbers this produces. A
  // fleet sitting on 184 668 findings cannot be cleared by 184 668 requests,
  // and a backlog nobody can clear is a backlog everybody stops reading.
  //
  // Two shapes:
  //   { ids: [...] }        the rows ticked on screen
  //   { all: true, ...f }   everything matching the CURRENT filters — the same
  //                         ones the list and summary use, so "accept what I am
  //                         looking at" accepts exactly that and nothing wider
  //
  // `all` has to be explicit. An empty body meaning "acknowledge the entire
  // history" is the kind of default that gets discovered the hard way.
  router.post(
    '/ack',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const wantsAll = body.all === true;
      const hasIds = Array.isArray(body.ids);
      if (wantsAll === hasIds) {
        return res.status(400).json({ error: 'Send either { ids: [...] } or { all: true } with filters, not both' });
      }

      if (hasIds) {
        if (!body.ids.length) return res.status(400).json({ error: 'ids must not be empty' });
        if (body.ids.length > MAX_ACK_IDS) {
          return res.status(400).json({ error: `ids must hold at most ${MAX_ACK_IDS} findings — use { all: true } with filters instead` });
        }
        // Finding ids are UUIDs, so they are strings; anything else is a
        // mistake worth refusing rather than silently matching nothing.
        if (!body.ids.every((id) => typeof id === 'string' && id.length && id.length <= 64)) {
          return res.status(400).json({ error: 'ids must be finding id strings' });
        }
        const acked = await findingStore.ackMany({ ids: body.ids });
        if (auditLogger) {
          await auditLogger.record(req, {
            category: 'analysis', action: 'findings_ack_bulk',
            target: `ids:${body.ids.length}`, detail: `acked=${acked} of ${body.ids.length} selected`,
          });
        }
        return res.json({ acked, requested: body.ids.length });
      }

      const parsed = parseListFilters(req.query);
      if (parsed.error) {
        return res.status(400).json({ error: 'Validation failed', details: parsed.error });
      }
      const acked = await findingStore.ackMany({ filter: parsed.filters });
      if (auditLogger) {
        // The FILTER is the record. "Accepted 184 632" without saying which
        // 184 632 is not something an auditor can check afterwards.
        const scope = Object.keys(parsed.filters).length
          ? Object.entries(parsed.filters).map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString() : v}`).join(' ')
          : '(everything)';
        await auditLogger.record(req, {
          category: 'analysis', action: 'findings_ack_bulk',
          target: 'filter', detail: `acked=${acked} scope=${scope}`,
        });
      }
      return res.json({ acked, filter: parsed.filters });
    })
  );

  return router;
}

module.exports = { createFindingsRouter };
