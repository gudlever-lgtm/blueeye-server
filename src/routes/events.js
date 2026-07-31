'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { canTransition, requiresComment, isStatus } = require('../eventCases/stateMachine');
const { validateStatusPatch } = require('../validation/eventCaseValidation');
const { validateEventNote } = require('../validation/eventNoteValidation');
const { buildTimeline } = require('../eventCases/timeline');
const { maskedDiff } = require('../config/configContext');
const { scoreSimilarEvents } = require('../eventCases/similarity');
const { gatherEventAskContext } = require('../eventCases/askContext');
const { buildEventGuide } = require('../eventCases/guide');
const { buildMatchingPlaybook, buildHistoricalMatches, shouldGenerateAi } = require('../eventCases/recommendation');
const { buildExplanation } = require('../eventCases/explanation');
const { EVENT_INSUFFICIENT_ANSWER } = require('../analysis/assistant');

const SEVERITIES = ['INFO', 'WARN', 'CRIT'];
const OPERATOR_ROLES = [ROLES.OPERATOR, ROLES.ADMIN]; // force_ai (costs a Mistral call) is operator+

function parseEventId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseDate(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// EVENTS — the operator-facing unit of "something is wrong on this device",
// stored in `event_cases` and wrapping the analysis findings (anomalies) that
// evidence it.
//
//   GET   /api/events        viewer+   list (filter status/severity/device/time)
//   GET   /api/events/:id    viewer+   one event + its linked anomalies
//   PATCH /api/events/:id    operator+ status transition (audited, RBAC)
//
// TERMINOLOGY. BlueEyes produces *events*; an **incident** is what an ITSM
// (ServiceNow, TOPdesk, a custom connector) opens FROM an event, and it lives in
// that system with its own number, SLA and owner. Calling our own row an
// "incident" made those two indistinguishable — so the noun here is "event", and
// "incident" is reserved for the ITSM object. See docs/events.md.
//
// /api/events is the only path and `event`/`events`/`eventId` the only response
// keys: the deprecated /api/incidents alias and the duplicated `incident*` keys
// were removed with the rest of the vocabulary. Storage matches — the rows live
// in `event_cases` as of migration 077.
//
// Follows the existing RBAC pattern (viewer < operator < admin): reads are
// viewer+, status changes are operator/admin. Every transition is recorded in
// the hash-chained audit_log via the injected auditLogger.
function createEventsRouter({
  eventCasesRepo,
  findingStore,
  auditLogger = null,
  auditEventsRepo = null,
  auditLogRepo = null,
  configSnapshotsRepo = null,
  agentsRepo = null,
  assistant = null,
  featureGate = null,
  askCache = null,
  remediationPlaybooksRepo = null,
  blastRadiusService = null,
  eventNotesRepo = null,
}) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const writer = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  // GET /api/events — filterable list. viewer+.
  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    const { status, severity, device } = req.query;
    if (status && !isStatus(status)) {
      return res.status(400).json({ error: 'invalid status filter' });
    }
    if (severity && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'invalid severity filter' });
    }
    const events = await eventCasesRepo.list({
      status: status || null,
      severity: severity || null,
      hostId: device || null,
      from: parseDate(req.query.from),
      to: parseDate(req.query.to),
    });
    return res.json({ events });
  }));

  // GET /api/events/:id — one event plus its linked anomalies. viewer+.
  router.get('/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseEventId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const event = await eventCasesRepo.findById(id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const anomalies = await findingStore.listByEventCase(id);

    // Playbook runs recorded against this event (empty when the subsystem/repo
    // is not wired). Read-only here; the recommendation endpoint interprets them.
    const playbookRuns = remediationPlaybooksRepo && typeof remediationPlaybooksRepo.listRunsForEvent === 'function'
      ? await remediationPlaybooksRepo.listRunsForEvent(id) : [];

    // Separate, light explanation (what/where/why) — a small extension of the
    // event response, delivered here rather than bundled into the recommendation.
    const primaryFinding = event.primaryFindingId && findingStore
      ? await findingStore.get(event.primaryFindingId) : null;
    const agent = agentsRepo && typeof agentsRepo.findById === 'function' && Number.isInteger(Number(event.hostId))
      ? await agentsRepo.findById(Number(event.hostId)) : null;
    const explanation = buildExplanation({ event, primaryFinding, agent });

    // Blast-radius enrichment (one added field on the event object): which
    // downstream hosts/services are affected if this device fails. Computed on
    // read from the topology graph, seeded by the event's agent-id host.
    // Best-effort — a topology/DB hiccup must not break the event view.
    if (blastRadiusService && typeof blastRadiusService.compute === 'function' && Number.isInteger(Number(event.hostId))) {
      try {
        event.blastRadius = await blastRadiusService.compute(Number(event.hostId));
      } catch (err) {
        event.blastRadius = null;
      }
    }

    return res.json({ event, anomalies, playbookRuns, explanation });
  }));

  // GET /api/events/:id/timeline — a flat, chronological read-model merging
  // the event's anomalies, config-changes on its device, and status changes.
  // No new storage. viewer+.
  router.get('/:id/timeline', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseEventId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const event = await eventCasesRepo.findById(id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Linked anomalies (findings), chronological.
    const anomalies = await findingStore.listByEventCase(id);

    // Config-changes on the same device within the event's active window.
    // The device is the finding host_id, which the ingest path sets to the agent
    // id — so match audit_events with target_type='agent' target_id=host_id.
    // Not yet FK-linked to the event (that is a later phase) — display only.
    let configChanges = [];
    if (auditEventsRepo && typeof auditEventsRepo.findByTarget === 'function') {
      configChanges = await auditEventsRepo.findByTarget({
        targetType: 'agent',
        targetId: event.hostId,
        from: event.firstEventAt,
        to: event.resolvedAt || null, // open event ⇒ unbounded (up to now)
      });
    }

    // Manual + automatic status changes from the hash-chained audit_log. Reads
    // BOTH categories: entries written before the rename carry `incident`, and
    // the chain makes rewriting them impossible — so an event opened last month
    // would otherwise lose its whole status history on upgrade.
    let statusChanges = [];
    if (auditLogRepo && typeof auditLogRepo.listByTarget === 'function') {
      statusChanges = await auditLogRepo.listByTarget({ category: ['event', 'incident'], target: String(id) });
    }

    const events = buildTimeline({ anomalies, configChanges, statusChanges });
    return res.json({ eventId: id, events });
  }));

  // GET /api/events/:id/config-context — the device-config change suspected to
  // have triggered this event (Fase 3 pt 4/5): the linked change, its masked
  // + risk-classified diff, and "suspected trigger N minutes before". Contains
  // device-config, so operator/admin only. Returns nulls when nothing is linked.
  router.get('/:id/config-context', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseEventId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const event = await eventCasesRepo.findById(id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const empty = { eventId: id, configChangeId: event.configChangeId ?? null, change: null, diff: null, suspectedTrigger: null };
    if (!event.configChangeId || !configSnapshotsRepo) return res.json(empty);

    const change = await configSnapshotsRepo.findById(event.configChangeId);
    if (!change) return res.json(empty);

    const prev = await configSnapshotsRepo.previousBefore(change.deviceId, change.id);
    const diff = maskedDiff(prev ? prev.configText : null, change.configText);
    const minutesBefore = event.firstEventAt && change.capturedAt
      ? Math.max(0, Math.round((new Date(event.firstEventAt).getTime() - new Date(change.capturedAt).getTime()) / 60000))
      : null;

    return res.json({
      eventId: id,
      configChangeId: change.id,
      change: { id: change.id, deviceId: change.deviceId, capturedAt: change.capturedAt, capturedVia: change.capturedVia },
      diff,
      suspectedTrigger: minutesBefore == null ? null : {
        minutesBefore,
        note: `Suspected trigger: configuration change ${minutesBefore} minutes earlier.`,
      },
    });
  }));

  // GET /api/events/:id/similar — earlier resolved/closed events that match
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

  // Shared similarity ranking (Fase 4). Builds the target's matching criteria,
  // pulls the past resolved/closed candidates, enriches each with its config-
  // change risk class, and returns the top-`limit` scored candidates plus the
  // (enriched) candidate pool. `statuses` narrows the pool — the recommendation
  // read-model passes ['resolved'] (a closed-without-resolution is not a solution),
  // the /similar endpoint keeps the default (resolved + closed). No re-scoring by
  // callers: order + score come straight from scoreSimilarEvents.
  async function rankSimilar(event, id, { limit = 5, statuses } = {}) {
    const primaryFinding = event.primaryFindingId && findingStore
      ? await findingStore.get(event.primaryFindingId) : null;
    const platform = agentsRepo && typeof agentsRepo.findById === 'function' && Number.isInteger(Number(event.hostId))
      ? (await agentsRepo.findById(Number(event.hostId)))?.platform ?? null : null;
    const target = {
      id: event.id,
      hostId: event.hostId,
      platform,
      primaryMetric: primaryFinding ? primaryFinding.metric : null,
      configChangeType: await configChangeType(event.configChangeId),
    };
    const candidates = typeof eventCasesRepo.listResolvedClosed === 'function'
      ? await eventCasesRepo.listResolvedClosed({ excludeId: id, limit: 50, ...(statuses ? { statuses } : {}) }) : [];
    // Enrich candidates' config-change risk class (only those that have one).
    for (const c of candidates) {
      // eslint-disable-next-line no-await-in-loop
      c.configChangeType = await configChangeType(c.configChangeId);
    }
    const ranked = scoreSimilarEvents(target, candidates, { limit });
    return { target, candidates, ranked };
  }

  router.get('/:id/similar', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseEventId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const event = await eventCasesRepo.findById(id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const { ranked } = await rankSimilar(event, id, { limit: 5 });
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

    return res.json({ eventId: id, similar });
  }));

  // (c) ai_suggestion. Generated ONLY when there is no matching playbook AND no
  // historical match, or when an operator forced it (?force_ai=true). Reuses the
  // EXISTING masked/aggregated context (gatherEventAskContext — same masking as
  // POST /:id/ask; raw config never leaves the process) and the honest
  // insufficient-context fallback, and caches per event+context-hash. Returns
  // null when the AI is not eligible / not available / errored — a read endpoint
  // must never let an AI problem sink sections (a) + (b).
  async function generateAiSuggestion({ id, forceAi, matchingPlaybook, historicalMatches }) {
    if (!shouldGenerateAi({ matchingPlaybook, historicalMatches, forceAi })) return null;
    if (!assistant) return null;
    if (featureGate && typeof featureGate.isFeatureEnabled === 'function' && !featureGate.isFeatureEnabled('assistant')) return null;
    if (typeof assistant.isEnabled === 'function' && !assistant.isEnabled()) return null;

    const context = await gatherEventAskContext(id, { eventCasesRepo, findingStore, auditEventsRepo, auditLogRepo, configSnapshotsRepo });
    if (!context) return null;

    // No context at all → the honest fallback, WITHOUT a provider call.
    if (!context.dataAvailability || !context.dataAvailability.hasAnyData) {
      return { source: 'ai_generated', suggestion: EVENT_INSUFFICIENT_ANSWER, sufficient: false, model: null, cached: false };
    }

    // Cache per event + context-hash (reuse askCache; tag to avoid colliding
    // with /:id/ask question keys).
    const cacheKey = `recommendation\n${JSON.stringify(context)}`;
    const hit = askCache && askCache.get(id, cacheKey);
    if (hit) return { ...hit, cached: true };

    let result;
    try {
      result = await assistant.suggestRemediation(context);
    } catch (err) {
      return null; // FeatureDisabled / Misconfigured / Upstream — keep (a)+(b).
    }

    // The model must never fabricate: it either returns the pinned insufficient
    // string (sufficient:false) or a concrete, context-grounded suggestion.
    const sufficient = result.answer !== EVENT_INSUFFICIENT_ANSWER;
    const value = { source: 'ai_generated', suggestion: result.answer, sufficient, model: result.model, cached: false };
    if (askCache) askCache.set(id, cacheKey, value);
    return value;
  }

  // GET /api/events/:id/recommendation — a single, combined recommendation in
  // three ordered sections: (a) matching_playbook, (b) historical_matches, then
  // (c) ai_suggestion. Read-only, so viewer+. `?force_ai=true` forces the AI
  // fallback and is operator/admin only (it costs a Mistral call).
  router.get('/:id/recommendation', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseEventId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    const forceAi = req.query.force_ai === 'true';
    if (forceAi && !OPERATOR_ROLES.includes(req.user && req.user.role)) {
      return res.status(403).json({ error: 'Forbidden', requiredRoles: OPERATOR_ROLES });
    }

    const event = await eventCasesRepo.findById(id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const primaryFinding = event.primaryFindingId && findingStore
      ? await findingStore.get(event.primaryFindingId) : null;
    const anomalyType = primaryFinding ? primaryFinding.metric : null;

    // (a) matching_playbook — match on the event's primary anomaly-type. If the
    // playbook already ran on this event, show its result instead of re-suggesting.
    let matchedPlaybook = null;
    let playbookRuns = [];
    if (remediationPlaybooksRepo && typeof remediationPlaybooksRepo.matchByAnomalyType === 'function') {
      matchedPlaybook = await remediationPlaybooksRepo.matchByAnomalyType(anomalyType);
      if (matchedPlaybook && typeof remediationPlaybooksRepo.listRunsForEvent === 'function') {
        playbookRuns = await remediationPlaybooksRepo.listRunsForEvent(id);
      }
    }
    const matchingPlaybook = buildMatchingPlaybook(matchedPlaybook, playbookRuns);

    // (b) historical_matches — reuse Fase-4 similarity, RESOLVED-only. No re-scoring.
    const { ranked, candidates } = await rankSimilar(event, id, { limit: 5, statuses: ['resolved'] });
    const runsByEvent = {};
    if (remediationPlaybooksRepo && typeof remediationPlaybooksRepo.listRunsForEvent === 'function') {
      for (const r of ranked) {
        // eslint-disable-next-line no-await-in-loop
        runsByEvent[r.id] = await remediationPlaybooksRepo.listRunsForEvent(r.id);
      }
    }
    const historicalMatches = buildHistoricalMatches(ranked, { runsByEvent, resolvedCandidates: candidates });

    // (c) ai_suggestion — only when (a) is null AND (b) is empty, or force_ai=true.
    const aiSuggestion = await generateAiSuggestion({ id, forceAi, matchingPlaybook, historicalMatches });

    return res.json({
      eventId: id,
      eventId: id,
      matching_playbook: matchingPlaybook,
      historical_matches: historicalMatches,
      ai_suggestion: aiSuggestion,
    });
  }));

  // Compact config-context (change id + minutes-before + risk) for the guide.
  async function configContextForGuide(event) {
    if (!event.configChangeId || !configSnapshotsRepo) return null;
    const change = await configSnapshotsRepo.findById(event.configChangeId);
    if (!change) return null;
    const prev = await configSnapshotsRepo.previousBefore(change.deviceId, change.id);
    const d = maskedDiff(prev ? prev.configText : null, change.configText);
    const minutesBefore = event.firstEventAt && change.capturedAt
      ? Math.max(0, Math.round((new Date(event.firstEventAt).getTime() - new Date(change.capturedAt).getTime()) / 60000))
      : null;
    return { configChangeId: change.id, minutesBefore, risk: d.risk, riskReasons: d.riskReasons };
  }

  // Top-N similar past events (light shape) for the guide's resolution step.
  async function topSimilar(event, id, limit) {
    const { ranked } = await rankSimilar(event, id, { limit });
    return ranked.map((r) => ({
      id: r.id, title: r.title, resolvedAt: r.resolvedAt ?? null, closedBy: r.closedByEmail ?? null,
    }));
  }

  // GET /api/events/:id/guide — a deterministic, local, explainable step-by-step
  // troubleshooting guide ("Guide me") built from the event's data (anomaly
  // type, correlated config change, similar prior events). Always available; the
  // opt-in AI assistant augments it in the UI via POST /:id/ask. operator/admin.
  router.get('/:id/guide', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseEventId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const event = await eventCasesRepo.findById(id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const anomalies = findingStore ? await findingStore.listByEventCase(id) : [];
    const configContext = await configContextForGuide(event);
    const similar = await topSimilar(event, id, 2);

    return res.json(buildEventGuide({ event, anomalies, configContext, similar }));
  }));

  // POST /api/events/:id/ask — free-text question about the event, answered
  // by the opt-in EU (Mistral) assistant using ONLY the masked/aggregated context
  // (askContext). Operator/admin (the context is config-derived). Short-lived
  // cache per event+question; each ask is recorded in the hash-chained audit.
  router.post('/:id/ask', requireAuth, writer, asyncHandler(async (req, res) => {
    if (!assistant) return res.status(404).json({ error: 'Assistant is not available' });
    // License gate (distinct from the runtime on/off below).
    if (featureGate && !featureGate.isFeatureEnabled('assistant')) {
      return res.status(403).json({ error: 'This feature is not included in your license', feature: 'assistant', reason: 'license' });
    }
    const id = parseEventId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const question = typeof (req.body || {}).question === 'string' ? req.body.question : '';
    if (question.trim() === '') {
      return res.status(400).json({ error: 'Validation failed', details: { question: 'question is required' } });
    }
    if (typeof assistant.isEnabled === 'function' && !assistant.isEnabled()) {
      return res.status(403).json({ error: 'The AI assistant is disabled (enable it in Settings → AI assistant)' });
    }

    const context = await gatherEventAskContext(id, { eventCasesRepo, findingStore, auditEventsRepo, auditLogRepo, configSnapshotsRepo });
    if (!context) return res.status(404).json({ error: 'Event not found' });

    // No context at all → the honest fallback, WITHOUT a provider call.
    if (!context.dataAvailability.hasAnyData) {
      return res.json({ answer: EVENT_INSUFFICIENT_ANSWER, model: null, cached: false, aiGenerated: true, dataAvailable: false });
    }

    // Cache hit → return without hitting Mistral again.
    const hit = askCache && askCache.get(id, question);
    if (hit) return res.json({ ...hit, cached: true });

    let result;
    try {
      result = await assistant.askEvent(question, context);
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
        category: 'event',
        action: 'event_ask',
        target: String(id),
        detail: `q="${question.trim().slice(0, 180)}" → ${String(result.answer).slice(0, 200)}`,
      });
    }

    return res.json({ ...value, cached: false });
  }));

  // PATCH /api/events/:id — status transition. operator/admin only.
  router.patch('/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseEventId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    const { value, errors } = validateStatusPatch(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const existing = await eventCasesRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Event not found' });

    const from = existing.status;
    const to = value.status;
    if (!canTransition(from, to)) {
      return res.status(409).json({ error: `Illegal transition ${from} → ${to}` });
    }
    if (requiresComment(from, to) && !value.comment) {
      return res.status(400).json({ error: 'A comment is required to reopen an event' });
    }

    const ok = await eventCasesRepo.updateStatus(id, {
      from,
      to,
      closedBy: to === 'closed' ? (req.user && req.user.id) || null : null,
      at: to === 'resolved' ? new Date() : null,
    });
    if (!ok) {
      // The row's status changed between our read and write (or vanished).
      return res.status(409).json({ error: 'Event status changed concurrently; please retry' });
    }

    if (auditLogger) {
      const detail = `${from}→${to}${value.comment ? `: ${value.comment}` : ''}`;
      await auditLogger.record(req, { category: 'event', action: 'event_status_change', target: String(id), detail });
    }

    const updated = await eventCasesRepo.findById(id);
    return res.json({ event: updated });
  }));

  // --- Work log (shift handover) --------------------------------------------
  // Only mounted when a notes repo is wired, so an older deployment that has not
  // run migration 072 keeps serving the rest of the event API instead of
  // 500-ing on a missing table.
  if (eventNotesRepo) {
    // GET /api/events/:id/notes — the full log plus the ruled-out subset.
    // viewer+ (reading a handover is not a privileged action).
    //
    // `ruledOut` is returned as its own array rather than left for the client to
    // filter: it is queried separately (indexed) so exclusions can never be the
    // rows that fall off the `limit`, and the UI pins them above the log.
    router.get('/:id/notes', requireAuth, reader, asyncHandler(async (req, res) => {
      const id = parseEventId(req.params.id);
      if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

      const event = await eventCasesRepo.findById(id);
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const [notes, ruledOut, total] = await Promise.all([
        eventNotesRepo.listForEvent({ eventCaseId: id }),
        eventNotesRepo.listRuledOut({ eventCaseId: id }),
        eventNotesRepo.countForEvent({ eventCaseId: id }),
      ]);

      return res.json({ eventId: id, notes, ruledOut, total });
    }));

    // POST /api/events/:id/notes — append one entry. operator+ (viewer reads
    // but does not write, per the RBAC ladder used everywhere else here).
    //
    // Append-only: there is deliberately no PATCH/DELETE counterpart, and the
    // repository exposes no method that could implement one.
    router.post('/:id/notes', requireAuth, writer, asyncHandler(async (req, res) => {
      const id = parseEventId(req.params.id);
      if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

      const { value, errors } = validateEventNote(req.body);
      if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

      const event = await eventCasesRepo.findById(id);
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const note = await eventNotesRepo.append({
        eventCaseId: id,
        kind: value.kind,
        text: value.text,
        authorUserId: (req.user && req.user.id) || null,
        authorEmail: (req.user && req.user.email) || null,
        authorRole: (req.user && req.user.role) || null,
      });

      // Into the hash-chained audit log. The note TEXT is not copied here — the
      // note row is the record, and duplicating free text into the audit trail
      // would put operator prose somewhere it can never be corrected. The chain
      // records that an entry of this kind was appended, and by whom.
      if (auditLogger) {
        await auditLogger.record(req, {
          category: 'event',
          action: 'event_note_append',
          target: String(id),
          detail: `${value.kind} note #${note ? note.id : '?'} (${value.text.length} chars)`,
        });
      }

      return res.status(201).json({ note });
    }));
  }

  return router;
}

module.exports = { createEventsRouter };
