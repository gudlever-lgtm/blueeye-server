'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { canTransition, requiresComment, isStatus } = require('../incidentCases/stateMachine');
const { validateStatusPatch } = require('../validation/incidentCaseValidation');
const { buildTimeline } = require('../incidentCases/timeline');
const { maskedDiff } = require('../config/configContext');
const { scoreSimilarIncidents } = require('../incidentCases/similarity');
const { gatherIncidentAskContext } = require('../incidentCases/askContext');
const { INCIDENT_INSUFFICIENT_ANSWER } = require('../analysis/assistant');

const SEVERITIES = ['INFO', 'WARN', 'CRIT'];

function parseIncidentId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseDate(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// First-class incidents (incident_cases) wrapping analysis findings.
//   GET   /api/incidents        viewer+   list (filter status/severity/device/time)
//   GET   /api/incidents/:id    viewer+   one incident + its linked anomalies
//   PATCH /api/incidents/:id    operator+ status transition (audited, RBAC)
//
// Follows the existing RBAC pattern (viewer < operator < admin): reads are
// viewer+, status changes are operator/admin. Every transition is recorded in
// the hash-chained audit_log via the injected auditLogger.
function createIncidentsRouter({
  incidentCasesRepo,
  findingStore,
  auditLogger = null,
  auditEventsRepo = null,
  auditLogRepo = null,
  configSnapshotsRepo = null,
  agentsRepo = null,
  assistant = null,
  featureGate = null,
  askCache = null,
}) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const writer = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  // GET /api/incidents — filterable list. viewer+.
  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    const { status, severity, device } = req.query;
    if (status && !isStatus(status)) {
      return res.status(400).json({ error: 'invalid status filter' });
    }
    if (severity && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'invalid severity filter' });
    }
    const incidents = await incidentCasesRepo.list({
      status: status || null,
      severity: severity || null,
      hostId: device || null,
      from: parseDate(req.query.from),
      to: parseDate(req.query.to),
    });
    return res.json({ incidents });
  }));

  // GET /api/incidents/:id — one incident plus its linked anomalies. viewer+.
  router.get('/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseIncidentId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const incident = await incidentCasesRepo.findById(id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    const anomalies = await findingStore.listByIncidentCase(id);
    // Playbook runs are not modelled in this codebase (no playbook subsystem);
    // the key is present for forward-compatibility and always empty for now.
    return res.json({ incident, anomalies, playbookRuns: [] });
  }));

  // GET /api/incidents/:id/timeline — a flat, chronological read-model merging
  // the incident's anomalies, config-changes on its device, and status changes.
  // No new storage. viewer+.
  router.get('/:id/timeline', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseIncidentId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const incident = await incidentCasesRepo.findById(id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });

    // Linked anomalies (findings), chronological.
    const anomalies = await findingStore.listByIncidentCase(id);

    // Config-changes on the same device within the incident's active window.
    // The device is the finding host_id, which the ingest path sets to the agent
    // id — so match audit_events with target_type='agent' target_id=host_id.
    // Not yet FK-linked to the incident (that is a later phase) — display only.
    let configChanges = [];
    if (auditEventsRepo && typeof auditEventsRepo.findByTarget === 'function') {
      configChanges = await auditEventsRepo.findByTarget({
        targetType: 'agent',
        targetId: incident.hostId,
        from: incident.firstEventAt,
        to: incident.resolvedAt || null, // open incident ⇒ unbounded (up to now)
      });
    }

    // Manual + automatic status changes from the hash-chained audit_log.
    let statusChanges = [];
    if (auditLogRepo && typeof auditLogRepo.listByTarget === 'function') {
      statusChanges = await auditLogRepo.listByTarget({ category: 'incident', target: String(id) });
    }

    const events = buildTimeline({ anomalies, configChanges, statusChanges });
    return res.json({ incidentId: id, events });
  }));

  // GET /api/incidents/:id/config-context — the device-config change suspected to
  // have triggered this incident (Fase 3 pt 4/5): the linked change, its masked
  // + risk-classified diff, and "suspected trigger N minutes before". Contains
  // device-config, so operator/admin only. Returns nulls when nothing is linked.
  router.get('/:id/config-context', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseIncidentId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const incident = await incidentCasesRepo.findById(id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });

    const empty = { incidentId: id, configChangeId: incident.configChangeId ?? null, change: null, diff: null, suspectedTrigger: null };
    if (!incident.configChangeId || !configSnapshotsRepo) return res.json(empty);

    const change = await configSnapshotsRepo.findById(incident.configChangeId);
    if (!change) return res.json(empty);

    const prev = await configSnapshotsRepo.previousBefore(change.deviceId, change.id);
    const diff = maskedDiff(prev ? prev.configText : null, change.configText);
    const minutesBefore = incident.firstEventAt && change.capturedAt
      ? Math.max(0, Math.round((new Date(incident.firstEventAt).getTime() - new Date(change.capturedAt).getTime()) / 60000))
      : null;

    return res.json({
      incidentId: id,
      configChangeId: change.id,
      change: { id: change.id, deviceId: change.deviceId, capturedAt: change.capturedAt, capturedVia: change.capturedVia },
      diff,
      suspectedTrigger: minutesBefore == null ? null : {
        minutesBefore,
        note: `Suspected trigger: configuration change ${minutesBefore} minutes earlier.`,
      },
    });
  }));

  // GET /api/incidents/:id/similar — earlier resolved/closed incidents that match
  // this one (Fase 4): same device or device-type, same primary anomaly type, and
  // — where available — the same config-change risk class. Weighted, top 5, most
  // similar first. Read-model only. viewer+.
  async function configChangeType(configChangeId) {
    if (!configChangeId || !configSnapshotsRepo) return null;
    const change = await configSnapshotsRepo.findById(configChangeId);
    if (!change) return null;
    const prev = await configSnapshotsRepo.previousBefore(change.deviceId, change.id);
    const risk = maskedDiff(prev ? prev.configText : null, change.configText).risk;
    return risk === 'none' ? null : risk;
  }

  router.get('/:id/similar', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseIncidentId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const incident = await incidentCasesRepo.findById(id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });

    // Enrich the target with its matching criteria.
    const primaryFinding = incident.primaryFindingId && findingStore
      ? await findingStore.get(incident.primaryFindingId) : null;
    const platform = agentsRepo && typeof agentsRepo.findById === 'function' && Number.isInteger(Number(incident.hostId))
      ? (await agentsRepo.findById(Number(incident.hostId)))?.platform ?? null : null;
    const target = {
      id: incident.id,
      hostId: incident.hostId,
      platform,
      primaryMetric: primaryFinding ? primaryFinding.metric : null,
      configChangeType: await configChangeType(incident.configChangeId),
    };

    const candidates = typeof incidentCasesRepo.listResolvedClosed === 'function'
      ? await incidentCasesRepo.listResolvedClosed({ excludeId: id, limit: 50 }) : [];
    // Enrich candidates' config-change risk class (only those that have one).
    for (const c of candidates) {
      // eslint-disable-next-line no-await-in-loop
      c.configChangeType = await configChangeType(c.configChangeId);
    }

    const ranked = scoreSimilarIncidents(target, candidates, { limit: 5 });
    const similar = ranked.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      severity: r.severity,
      primaryMetric: r.primaryMetric ?? null,
      resolvedAt: r.resolvedAt ?? null,
      closedBy: r.closedByEmail ?? null,
      score: r.score,
      matchedOn: r.matchedOn,
      // No playbook subsystem exists in this codebase, so remediation history is
      // not available — surfaced as null rather than omitted.
      playbook: null,
      playbookSucceeded: null,
    }));

    return res.json({ incidentId: id, similar });
  }));

  // POST /api/incidents/:id/ask — free-text question about the incident, answered
  // by the opt-in EU (Mistral) assistant using ONLY the masked/aggregated context
  // (askContext). Operator/admin (the context is config-derived). Short-lived
  // cache per incident+question; each ask is recorded in the hash-chained audit.
  router.post('/:id/ask', requireAuth, writer, asyncHandler(async (req, res) => {
    if (!assistant) return res.status(404).json({ error: 'Assistant is not available' });
    // License gate (distinct from the runtime on/off below).
    if (featureGate && !featureGate.isFeatureEnabled('assistant')) {
      return res.status(403).json({ error: 'This feature is not included in your license', feature: 'assistant', reason: 'license' });
    }
    const id = parseIncidentId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const question = typeof (req.body || {}).question === 'string' ? req.body.question : '';
    if (question.trim() === '') {
      return res.status(400).json({ error: 'Validation failed', details: { question: 'question is required' } });
    }
    if (typeof assistant.isEnabled === 'function' && !assistant.isEnabled()) {
      return res.status(403).json({ error: 'The AI assistant is disabled (enable it in Settings → AI assistant)' });
    }

    const context = await gatherIncidentAskContext(id, { incidentCasesRepo, findingStore, auditEventsRepo, auditLogRepo, configSnapshotsRepo });
    if (!context) return res.status(404).json({ error: 'Incident not found' });

    // No context at all → the honest fallback, WITHOUT a provider call.
    if (!context.dataAvailability.hasAnyData) {
      return res.json({ answer: INCIDENT_INSUFFICIENT_ANSWER, model: null, cached: false, aiGenerated: true, dataAvailable: false });
    }

    // Cache hit → return without hitting Mistral again.
    const hit = askCache && askCache.get(id, question);
    if (hit) return res.json({ ...hit, cached: true });

    let result;
    try {
      result = await assistant.askIncident(question, context);
    } catch (err) {
      if (err && err.name === 'FeatureDisabled') return res.status(403).json({ error: err.message });
      if (err && err.name === 'InvalidQuestion') return res.status(400).json({ error: 'Validation failed', details: { question: 'question is required' } });
      throw err; // AssistantMisconfigured / AssistantUpstreamError / unknown → 500
    }

    const value = { answer: result.answer, model: result.model, aiGenerated: true, dataAvailable: true };
    if (askCache) askCache.set(id, question, value);

    // Audit: who asked, when, the question and a short answer excerpt. Metadata
    // only — the context sent to Mistral was already masked.
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'incident',
        action: 'incident_ask',
        target: String(id),
        detail: `q="${question.trim().slice(0, 180)}" → ${String(result.answer).slice(0, 200)}`,
      });
    }

    return res.json({ ...value, cached: false });
  }));

  // PATCH /api/incidents/:id — status transition. operator/admin only.
  router.patch('/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseIncidentId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    const { value, errors } = validateStatusPatch(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const existing = await incidentCasesRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Incident not found' });

    const from = existing.status;
    const to = value.status;
    if (!canTransition(from, to)) {
      return res.status(409).json({ error: `Illegal transition ${from} → ${to}` });
    }
    if (requiresComment(from, to) && !value.comment) {
      return res.status(400).json({ error: 'A comment is required to reopen an incident' });
    }

    const ok = await incidentCasesRepo.updateStatus(id, {
      from,
      to,
      closedBy: to === 'closed' ? (req.user && req.user.id) || null : null,
      at: to === 'resolved' ? new Date() : null,
    });
    if (!ok) {
      // The row's status changed between our read and write (or vanished).
      return res.status(409).json({ error: 'Incident status changed concurrently; please retry' });
    }

    if (auditLogger) {
      const detail = `${from}→${to}${value.comment ? `: ${value.comment}` : ''}`;
      await auditLogger.record(req, { category: 'incident', action: 'incident_status_change', target: String(id), detail });
    }

    const updated = await incidentCasesRepo.findById(id);
    return res.json({ incident: updated });
  }));

  return router;
}

module.exports = { createIncidentsRouter };
