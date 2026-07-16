'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { buildClusterDetail } = require('../analysis/clusterView');
const { dominantFindingTypes, buildRecommendedActions } = require('../remediation/recommendedActions');

// A cluster is still "live" (a playbook can be run against it) while open or
// acknowledged; resolved/closed clusters are done.
const LIVE_STATUSES = new Set(['open', 'acknowledged']);

// Cross-agent incident CLUSTERS (incident_clusters) — findings from ≥2 agents that
// fired together, grouped by the clustering engine (src/analysis/crossAgent*).
//
//   GET  /api/incident-clusters          viewer+   list (filter status/time, paged)
//   GET  /api/incident-clusters/:id      viewer+   full cluster: members, evidence,
//                                                   confidence breakdown, root cause
//   POST /api/incident-clusters/:id/ack      operator+  acknowledge (audited)
//   POST /api/incident-clusters/:id/resolve  operator+  resolve + required note (audited)
//
// NOTE ON THE MOUNT PATH: the task asked for `/api/incidents`, but that path is
// already the first-class `incident_cases` router (a DISTINCT feature). Clusters
// therefore live at `/api/incident-clusters`, matching how CODEMAP already names
// this feature. Same verbs/shapes as specified.
//
// RBAC mirrors the rest of the platform: reads are viewer+, state changes
// (ack/resolve) are operator/admin. Every state change is recorded in the
// hash-chained audit_log via the injected auditLogger (as src/routes/incidents.js).

const VALID_STATUSES = ['open', 'acknowledged', 'resolved', 'closed'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_LOOKBACK_MINUTES = 30;
const MAX_LOOKBACK_MINUTES = 24 * 60; // one day of lookback is plenty

function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseDate(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Bounded non-negative integer from a query param, or the fallback.
function parseIntParam(raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null; // signals a 400
  return n;
}

function createIncidentClustersRouter({
  clustersRepo, findingStore = null, auditLogger = null, timelineService = null,
  runbooksRepo = null, playbooksRepo = null, verificationService = null,
  settingsService = null, assistant = null, alertLog = null, notifier = null,
}) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const writer = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  // GET /api/incident-clusters — filterable, paginated list. viewer+.
  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    const { status } = req.query;
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'invalid status filter', allowed: VALID_STATUSES });
    }
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (req.query.from && !from) return res.status(400).json({ error: 'invalid from date' });
    if (req.query.to && !to) return res.status(400).json({ error: 'invalid to date' });

    const limit = parseIntParam(req.query.limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });
    const offset = parseIntParam(req.query.offset, 0, { min: 0 });
    if (limit === null) return res.status(400).json({ error: `limit must be 1..${MAX_LIMIT}` });
    if (offset === null) return res.status(400).json({ error: 'offset must be >= 0' });

    const filter = { status: status || null, from, to };
    const [clusters, total] = await Promise.all([
      clustersRepo.list({ ...filter, limit, offset }),
      typeof clustersRepo.count === 'function' ? clustersRepo.count(filter) : Promise.resolve(null),
    ]);

    return res.json({ clusters, page: { limit, offset, total } });
  }));

  // Hydrates a cluster's member findings, preserving member order and dropping
  // any that no longer exist (retention may have purged them).
  async function hydrateMembers(memberFindingIds) {
    if (!findingStore || typeof findingStore.get !== 'function') return [];
    const out = [];
    for (const id of memberFindingIds || []) {
      const f = await findingStore.get(id); // eslint-disable-line no-await-in-loop
      if (f) out.push(f);
    }
    return out;
  }

  // GET /api/incident-clusters/:id — full cluster with members, evidence,
  // confidence breakdown and suspected root-cause layer. viewer+.
  router.get('/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const cluster = await clustersRepo.findById(id);
    if (!cluster) return res.status(404).json({ error: 'Incident cluster not found' });

    const members = await hydrateMembers(cluster.memberFindingIds);
    return res.json({ cluster: buildClusterDetail(cluster, members) });
  }));

  // GET /api/incident-clusters/:id/timeline — one merged, chronological event
  // stream for the cluster's affected agents (member findings + cluster state
  // transitions + playbook runs + agent lifecycle + config changes), plus a
  // "what changed" slice of the pre-incident lookback window. viewer+.
  router.get('/:id/timeline', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    // lookback is in MINUTES (default 30, bounded); a garbage value is a 400.
    const lookback = parseIntParam(req.query.lookback, DEFAULT_LOOKBACK_MINUTES, { min: 1, max: MAX_LOOKBACK_MINUTES });
    if (lookback === null) return res.status(400).json({ error: `lookback must be 1..${MAX_LOOKBACK_MINUTES} minutes` });

    if (!timelineService || typeof timelineService.getTimeline !== 'function') {
      return res.status(404).json({ error: 'Timeline not available' });
    }
    const result = await timelineService.getTimeline(id, { lookbackMinutes: lookback });
    if (!result) return res.status(404).json({ error: 'Incident cluster not found' });
    return res.json(result);
  }));

  // GET /api/incident-clusters/:id/recommended-actions — runbooks matching the
  // cluster's dominant finding-types (static mapping first), plus the opt-in
  // cluster AI advisory (Fase 2) when the assistant is enabled. viewer+.
  router.get('/:id/recommended-actions', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const cluster = await clustersRepo.findById(id);
    if (!cluster) return res.status(404).json({ error: 'Incident cluster not found' });

    const members = await hydrateMembers(cluster.memberFindingIds);
    const findingTypes = dominantFindingTypes(members);
    const runbooks = runbooksRepo && typeof runbooksRepo.listByFindingTypes === 'function'
      ? await runbooksRepo.listByFindingTypes(findingTypes) : [];
    const mistralEnabled = !!(assistant && typeof assistant.isEnabled === 'function' && assistant.isEnabled());

    return res.json(buildRecommendedActions({ findingTypes, runbooks, advisory: cluster.advisory, mistralEnabled }));
  }));

  // Settle time (seconds) for post-remediation verification, from Settings →
  // Analysis (`verifySettleMinutes`, default 5 min). Read live at execution time.
  async function settleSeconds() {
    const fallback = 5 * 60;
    if (!settingsService || typeof settingsService.getAnalysis !== 'function') return fallback;
    try {
      const a = await settingsService.getAnalysis();
      const m = Number(a && a.verifySettleMinutes);
      return Number.isFinite(m) && m >= 0 ? Math.round(m * 60) : fallback;
    } catch { return fallback; }
  }

  // POST /api/incident-clusters/:id/run-playbook — operator+. Explicit, audited
  // execution of a playbook against the cluster's targets, which schedules a
  // post-remediation verification. No auto-execution — this is always operator-
  // initiated. Body: { runbookId } (uses the runbook's linked playbook) OR
  // { playbookId }.
  router.post('/:id/run-playbook', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    const body = req.body || {};
    const runbookId = body.runbookId != null ? parseId(body.runbookId) : null;
    let playbookId = body.playbookId != null ? parseId(body.playbookId) : null;
    if (runbookId === null && playbookId === null) {
      return res.status(400).json({ error: 'Validation failed', details: { playbookId: 'a runbookId or playbookId is required' } });
    }

    const cluster = await clustersRepo.findById(id);
    if (!cluster) return res.status(404).json({ error: 'Incident cluster not found' });
    if (!LIVE_STATUSES.has(cluster.status)) {
      return res.status(409).json({ error: `Cannot run a playbook against a ${cluster.status} cluster` });
    }

    // Resolve the playbook — directly, or via the runbook's link.
    let usedRunbookId = null;
    if (runbookId !== null) {
      const runbook = runbooksRepo && typeof runbooksRepo.findById === 'function' ? await runbooksRepo.findById(runbookId) : null;
      if (!runbook) return res.status(404).json({ error: 'Runbook not found' });
      if (runbook.linkedPlaybookId == null) {
        return res.status(400).json({ error: 'Validation failed', details: { runbookId: 'this runbook has no linked playbook to run' } });
      }
      usedRunbookId = runbook.id;
      playbookId = runbook.linkedPlaybookId;
    }
    const playbook = playbooksRepo && typeof playbooksRepo.findById === 'function' ? await playbooksRepo.findById(playbookId) : null;
    if (!playbook) return res.status(404).json({ error: 'Playbook not found' });

    const members = await hydrateMembers(cluster.memberFindingIds);
    const affectedTargets = [...new Set(members.map((f) => f.hostId).filter((h) => h != null).map(String))];
    const findingTypes = dominantFindingTypes(members);

    // Executing a playbook is audit-logged (the existing hash-chained audit).
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'incident', action: 'playbook_run', target: String(id),
        detail: `Ran playbook "${playbook.name}" (${playbook.actionType}) against ${affectedTargets.length} target(s)`,
      });
    }

    // Schedule the post-remediation verification (never auto-resolves).
    let verification = null;
    if (verificationService && typeof verificationService.schedule === 'function') {
      verification = await verificationService.schedule({
        clusterId: id, playbookId, runbookId: usedRunbookId,
        triggeredBy: (req.user && req.user.email) || 'operator',
        affectedTargets, findingTypes, settleSeconds: await settleSeconds(),
      });
    }

    return res.status(202).json({
      run: { playbookId, playbookName: playbook.name, runbookId: usedRunbookId, affectedTargets, findingTypes },
      verification,
    });
  }));

  // GET /api/incident-clusters/:id/notifications — the cluster's rollup state:
  // the ONE ITSM ticket ref, the ONE NIS2 draft id, and the cluster-level alert
  // history (opened/update/escalation/resolved). viewer+.
  router.get('/:id/notifications', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const cluster = await clustersRepo.findById(id);
    if (!cluster) return res.status(404).json({ error: 'Incident cluster not found' });

    const alerts = alertLog && typeof alertLog.listForSubject === 'function'
      ? await alertLog.listForSubject({ subjectType: 'cluster', subjectId: id }) : [];
    return res.json({
      clusterId: id,
      itsmTicketRef: cluster.itsmTicketRef ?? null,
      itsmIntegrationId: cluster.itsmIntegrationId ?? null,
      nis2DraftId: cluster.nis2DraftId ?? null,
      alertLastAt: cluster.alertLastAt ?? null,
      alertLastSeverity: cluster.alertLastSeverity ?? null,
      alerts,
    });
  }));

  // POST /api/incident-clusters/:id/ack — acknowledge (operator+). Audited.
  router.post('/:id/ack', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    const existing = await clustersRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Incident cluster not found' });

    const ok = await clustersRepo.acknowledge(id, { by: (req.user && req.user.id) || null, at: new Date() });
    if (!ok) {
      // Only an OPEN cluster can be acknowledged; anything else is a conflict.
      return res.status(409).json({ error: `Cannot acknowledge a cluster in status "${existing.status}"` });
    }

    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'incident', action: 'cluster_acknowledge', target: String(id),
        detail: `open→acknowledged (${existing.memberFindingIds.length} members)`,
      });
    }

    const updated = await clustersRepo.findById(id);
    return res.json({ cluster: updated });
  }));

  // POST /api/incident-clusters/:id/resolve — resolve with a REQUIRED free-text
  // note (operator+). Audited.
  router.post('/:id/resolve', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    const note = typeof (req.body || {}).note === 'string' ? req.body.note.trim() : '';
    if (note === '') {
      return res.status(400).json({ error: 'Validation failed', details: { note: 'a resolution note is required' } });
    }

    const existing = await clustersRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Incident cluster not found' });

    const ok = await clustersRepo.resolve(id, { by: (req.user && req.user.id) || null, note, at: new Date() });
    if (!ok) {
      // Already resolved/closed, or a concurrent change.
      return res.status(409).json({ error: `Cannot resolve a cluster in status "${existing.status}"` });
    }

    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'incident', action: 'cluster_resolve', target: String(id),
        detail: `${existing.status}→resolved: ${note.slice(0, 200)}`,
      });
    }

    // ONE resolution alert (+ ITSM worknote) with the note — best-effort, never
    // blocks the response. Only for clusters that were notified (medium/high).
    if (notifier && typeof notifier.notify === 'function' && ['medium', 'high'].includes(existing.confidence)) {
      const startMs = new Date(existing.createdAt || existing.detectedAt || Date.now()).getTime();
      const mins = Math.max(0, Math.round((Date.now() - startMs) / 60000));
      try {
        await notifier.notify({
          event: 'resolved',
          cluster: {
            clusterId: id, id, confidence: existing.confidence, severity: existing.alertLastSeverity || 'WARN',
            memberFindingIds: existing.memberFindingIds, suspectedCommonCause: existing.suspectedCommonCause,
            itsmTicketRef: existing.itsmTicketRef, durationText: `${mins} min`, resolutionNote: note,
          },
          members: [],
        });
      } catch { /* notification failure never affects the resolve */ }
    }

    const updated = await clustersRepo.findById(id);
    return res.json({ cluster: updated });
  }));

  return router;
}

module.exports = { createIncidentClustersRouter };
