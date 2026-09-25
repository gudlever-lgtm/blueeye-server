'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { canTransition, requiresComment, isStatus, STATUSES } = require('../eventCases/stateMachine');
const { validateStatusPatch } = require('../validation/eventCaseValidation');
const { validateEventNote } = require('../validation/eventNoteValidation');
const { buildTimeline } = require('../eventCases/timeline');
const { maskedDiff } = require('../config/configContext');
const { scoreSimilarEvents } = require('../eventCases/similarity');
const { silentLogger } = require('../logger');
const { gatherEventAskContext } = require('../eventCases/askContext');
const { buildEventGuide } = require('../eventCases/guide');
const { buildMatchingPlaybook, buildHistoricalMatches, shouldGenerateAi } = require('../eventCases/recommendation');
const { buildExplanation } = require('../eventCases/explanation');
const { EVENT_INSUFFICIENT_ANSWER } = require('../analysis/assistant');

const SEVERITIES = ['INFO', 'WARN', 'CRIT'];
// How many events one bulk transition may carry by id. Each is a read, a
// guarded write and an audit row, so this is a bound on the request's work, not
// a guess at what an operator might select — which is exactly why the number is
// an admin's to set (Settings → Events). This is the fallback for a server with
// no settings service wired, and the default the service ships.
const MAX_BULK_EVENTS = 500;
const BULK_DEFAULTS = { bulkMax: MAX_BULK_EVENTS, bulkAll: true };
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

// The filters the list is read with. ONE parser, used by the list endpoint and
// by the filter-scoped bulk transition, because "move everything I am looking
// at" is only true while both read the request the same way.
function parseEventFilters(input) {
  const q = input || {};
  const status = q.status ? String(q.status) : '';
  const severity = q.severity ? String(q.severity) : '';
  if (status && !isStatus(status)) return { error: 'invalid status filter' };
  if (severity && !SEVERITIES.includes(severity)) return { error: 'invalid severity filter' };
  const device = q.device == null ? '' : String(q.device).trim();
  return {
    value: {
      status: status || null,
      severity: severity || null,
      hostId: device || null,
      from: parseDate(q.from),
      to: parseDate(q.to),
    },
  };
}

// The filters, as a line an auditor can read back. The FILTER is the record
// when the action names no ids: "resolved 989" that does not say which 989 is
// not something anybody can check afterwards.
function describeFilters(f) {
  const parts = Object.entries(f || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString() : v}`);
  return parts.length ? parts.join(' ') : '(everything)';
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
  settingsService = null,
  logger = silentLogger,
}) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const writer = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  // The bulk policy an admin set (Settings → Events). Read per request rather
  // than at wiring time, so a changed cap applies to the next call instead of
  // the next restart. A settings read that fails falls back to the defaults:
  // a database hiccup must not turn every bulk action into a 500.
  async function bulkPolicy() {
    if (!settingsService || typeof settingsService.getEvents !== 'function') return { ...BULK_DEFAULTS };
    try {
      const s = await settingsService.getEvents();
      return {
        bulkMax: Number.isInteger(s && s.bulkMax) && s.bulkMax > 0 ? s.bulkMax : BULK_DEFAULTS.bulkMax,
        bulkAll: s ? s.bulkAll !== false : BULK_DEFAULTS.bulkAll,
      };
    } catch (err) {
      logger.warn(`events: bulk policy unreadable (${err && err.message}); using defaults`);
      return { ...BULK_DEFAULTS };
    }
  }

  // GET /api/events — filterable list. viewer+.
  //
  // The response carries the bulk policy as well as the rows: the page draws
  // the selection and the bulk bar, and it cannot be honest about either
  // without knowing the cap. Settings itself is admin-only, so an operator has
  // no other way to read it — and a cap discovered only by being refused is
  // how the 989-selected screenshot happened.
  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    const { value: filters, error } = parseEventFilters(req.query);
    if (error) return res.status(400).json({ error });
    const events = await eventCasesRepo.list(filters);
    const policy = await bulkPolicy();
    return res.json({ events, bulkMax: policy.bulkMax, bulkAll: policy.bulkAll });
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
    //
    // But "best-effort" must not mean "indistinguishable from an answer". This
    // is the field an operator acts on mid-incident, and `blastRadius: null`
    // used to mean BOTH "nothing downstream depends on this device" and "the
    // topology query failed" — with nothing logged either way. So the failure
    // is now logged AND reported: `blastRadiusError` tells the client the
    // difference, and the UI says "could not be computed" instead of quietly
    // implying an all-clear.
    if (blastRadiusService && typeof blastRadiusService.compute === 'function' && Number.isInteger(Number(event.hostId))) {
      try {
        event.blastRadius = await blastRadiusService.compute(Number(event.hostId));
      } catch (err) {
        event.blastRadius = null;
        event.blastRadiusError = 'unavailable';
        logger.warn(`events: blast radius for event ${id} (host ${event.hostId}) failed: ${err && err.message}`);
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

  // The filter-scoped half of POST /bulk-status: one transition applied to
  // EVERY event matching the same filters the list was read with.
  //
  // WHY IT EXISTS. The id form costs a read, a guarded write and an audit row
  // per event, so it is capped — and a queue of a thousand open events cannot
  // be cleared 500 ids at a time by somebody who is never going to scroll it.
  // This is one UPDATE and one audit row, and the cap does not apply because
  // the work no longer grows with the selection.
  //
  // WHAT IT KEEPS. The state machine: the legal `from` statuses for the target
  // are computed from the SAME table the single PATCH uses and go into the
  // WHERE, so an illegal transition cannot be performed — only missed. A reopen
  // still needs its comment. And the filters are the list's own, so this moves
  // what the operator was looking at rather than a wider set.
  //
  // WHAT IT GIVES UP, deliberately: a per-event outcome and a per-event audit
  // row. Naming 989 rows is not a report anybody reads, and writing 989 audit
  // rows is the per-event cost this exists to avoid. The FILTER is the record.
  async function bulkAll(req, res, body, policy) {
    if (!policy.bulkAll) {
      return res.status(403).json({ error: 'Filter-scoped bulk actions are disabled (Settings → Events)' });
    }
    if (typeof eventCasesRepo.updateStatusWhere !== 'function') {
      return res.status(501).json({ error: 'Filter-scoped bulk actions are not available on this server' });
    }

    const { value, errors } = validateStatusPatch(body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const to = value.status;

    // The filters travel in the BODY here (a POST with a body has no business
    // reading half its input from the query string), but they are the same
    // shape and the same parser as the list.
    const { value: filters, error } = parseEventFilters(body.filters || {});
    if (error) return res.status(400).json({ error });

    // Every status this transition is legal FROM, narrowed by the status filter
    // when one is set. A filter that cannot move anywhere is refused rather
    // than answered with "0 moved": the operator asked for something the state
    // machine does not allow, and silence would read as "nothing matched".
    const legal = STATUSES.filter((from) => canTransition(from, to));
    const froms = filters.status ? legal.filter((f) => f === filters.status) : legal;
    if (!froms.length) {
      return res.status(400).json({
        error: filters.status
          ? `no event with status ${filters.status} can move to ${to}`
          : `no status can move to ${to}`,
      });
    }
    // A reopen carries its reason in every form. Otherwise bulk becomes the
    // door that closes-and-reopens the history with nothing recorded.
    if (froms.some((from) => requiresComment(from, to)) && !value.comment) {
      return res.status(400).json({ error: 'A comment is required to reopen an event' });
    }

    const moved = await eventCasesRepo.updateStatusWhere({
      toStatus: to,
      fromStatuses: froms,
      severity: filters.severity,
      hostId: filters.hostId,
      from: filters.from,
      to: filters.to,
      closedBy: to === 'closed' ? (req.user && req.user.id) || null : null,
      at: to === 'resolved' ? new Date() : null,
    });

    if (auditLogger) {
      const scope = describeFilters({ ...filters, status: froms.join('|') });
      await auditLogger.record(req, {
        category: 'event',
        action: 'event_status_change_bulk',
        target: 'filter',
        detail: `→${to}${value.comment ? `: ${value.comment}` : ''} moved=${moved} scope=${scope} (bulk all)`,
      });
    }

    return res.status(200).json({ moved, all: true, status: to, scope: filters });
  }

  // PATCH /api/events/:id — status transition. operator/admin only.
  // POST /api/events/bulk-status — one transition applied to many events.
  //
  // Selecting fifty events and walking them one dialog at a time is how a
  // backlog stops being read. But bulk is exactly where a state machine gets
  // quietly bypassed, so this applies the SAME rules the single PATCH does,
  // per event, and reports what happened to each one:
  //
  //   moved       it transitioned
  //   illegal     that transition is not legal from where it is
  //   not_found   no such event
  //   conflict    somebody else changed it between our read and write
  //
  // PARTIAL SUCCESS IS A SUCCESS. Forty-eight events that moved must not be
  // rolled back because two were already resolved by a colleague — that is the
  // normal state of a shared queue, not an error.
  router.post('/bulk-status', requireAuth, writer, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const policy = await bulkPolicy();
    const wantsAll = body.all === true;
    const hasIds = Array.isArray(body.ids);
    // `all` has to be EXPLICIT, and it cannot be combined with ids. An empty
    // body meaning "resolve the entire queue" is the kind of default that gets
    // discovered the hard way.
    if (wantsAll && hasIds) {
      return res.status(400).json({ error: 'Send either { ids: [...] } or { all: true } with filters, not both' });
    }
    if (wantsAll) return bulkAll(req, res, body, policy);

    if (!Array.isArray(body.ids) || !body.ids.length) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    if (body.ids.length > policy.bulkMax) {
      return res.status(400).json({
        error: policy.bulkAll
          ? `ids must hold at most ${policy.bulkMax} events — use { all: true } with filters instead`
          : `ids must hold at most ${policy.bulkMax} events`,
        limit: policy.bulkMax,
        selected: body.ids.length,
      });
    }
    const ids = [];
    for (const raw of body.ids) {
      const id = parseEventId(raw);
      if (id === null) return res.status(400).json({ error: 'ids must be positive integers' });
      if (!ids.includes(id)) ids.push(id);
    }

    const { value, errors } = validateStatusPatch(body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const results = [];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const existing = await eventCasesRepo.findById(id);
      if (!existing) { results.push({ id, outcome: 'not_found' }); continue; }

      const from = existing.status;
      const to = value.status;
      if (from === to) { results.push({ id, outcome: 'unchanged', from, to }); continue; }
      if (!canTransition(from, to)) {
        // Named, not just counted: "3 could not be resolved" is unactionable
        // where "#41, #52 and #63 are still open" tells you what to do next.
        results.push({ id, outcome: 'illegal', from, to });
        continue;
      }
      if (requiresComment(from, to) && !value.comment) {
        results.push({ id, outcome: 'needs_comment', from, to });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const ok = await eventCasesRepo.updateStatus(id, {
        from,
        to,
        closedBy: to === 'closed' ? (req.user && req.user.id) || null : null,
        at: to === 'resolved' ? new Date() : null,
      });
      if (!ok) { results.push({ id, outcome: 'conflict', from, to }); continue; }
      results.push({ id, outcome: 'moved', from, to });

      if (auditLogger) {
        const detail = `${from}→${to}${value.comment ? `: ${value.comment}` : ''} (bulk)`;
        // One row PER EVENT, not one for the batch: the audit log answers
        // "what happened to event 52", and a single "bulk: 50 events" row
        // cannot.
        // eslint-disable-next-line no-await-in-loop
        await auditLogger.record(req, { category: 'event', action: 'event_status_change', target: String(id), detail });
      }
    }

    const moved = results.filter((r) => r.outcome === 'moved').length;
    return res.status(200).json({ moved, requested: ids.length, status: value.status, results });
  }));

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
