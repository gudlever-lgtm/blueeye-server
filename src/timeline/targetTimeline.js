'use strict';

// Pure read-model for the per-target (per-agent) incident timeline (Phase 1).
// Merges rows already read from existing sources — anomaly findings,
// probe-outage incidents, agent connect/disconnect (audit_events) and
// remediation playbook runs — into one flat, chronological event list. No
// storage, no I/O: callers fetch the rows (see targetTimelineService.js) and
// hand them here.
//
// This module is intentionally a standalone function (not embedded in the route
// handler) so later phases can reuse the exact same merge/normalise logic —
// e.g. Phase 3 ("what changed before this finding") filters this output down to
// the change-type events rather than running a second query path.
//
// Normalised event shape (per the endpoint contract):
//   { timestamp, source, type, severity, summary, ref_id }
//     timestamp — ISO-8601 string (the moment the event happened)
//     source    — one of SOURCES (finding|incident|agent|playbook)
//     type      — a dotted sub-type for display/deep-linking (e.g. 'cpu',
//                 'incident.reachability', 'agent.offline', 'playbook.success')
//     severity  — normalised to INFO|WARN|CRIT across all sources
//     summary   — one-line human-readable description
//     ref_id    — id of the ORIGINAL record so the frontend can deep-link back
//                 (finding uuid, incident id, audit-event id, playbook-run id)

const SOURCES = Object.freeze({
  FINDING: 'finding',
  INCIDENT: 'incident',
  AGENT: 'agent',
  PLAYBOOK: 'playbook',
});

// Stable tie-break order among events that share a timestamp — keeps the story
// readable and the output deterministic (important for tests).
const SOURCE_ORDER = { finding: 0, incident: 1, agent: 2, playbook: 3 };

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function ms(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// Every source ends up normalised to the finding vocabulary (INFO/WARN/CRIT) so
// the frontend can colour the whole timeline from one palette (see the Phase 1
// audit: severity colour-coding must match findings, not a new scheme).
function normalizeSeverity(sev) {
  if (sev == null) return 'INFO';
  const s = String(sev).toUpperCase();
  if (s === 'CRIT' || s === 'CRITICAL') return 'CRIT';
  if (s === 'WARN' || s === 'WARNING') return 'WARN';
  if (s === 'INFO') return 'INFO';
  return 'INFO';
}

// --- per-source mappers (each returns 0..n normalised events) ----------------

function mapFinding(f) {
  if (!f) return [];
  return [{
    timestamp: toIso(f.createdAt),
    source: SOURCES.FINDING,
    type: f.metric || (f.kind ? String(f.kind).toLowerCase() : 'anomaly'),
    severity: normalizeSeverity(f.severity),
    summary: f.explanation || `${f.severity || ''} ${f.metric || 'anomaly'}`.trim(),
    ref_id: f.id,
  }];
}

// A probe-outage incident is a span: it opens (started_at) and may later resolve
// (resolved_at). Surface the open event always, and the resolve event too when
// it falls in the fetched window — both deep-link to the same incident id.
function mapIncident(i) {
  if (!i) return [];
  const events = [];
  const metric = i.metric || 'outage';
  const target = i.affectedTarget ? ` on ${i.affectedTarget}` : '';
  events.push({
    timestamp: toIso(i.startedAt),
    source: SOURCES.INCIDENT,
    type: `incident.${metric}`,
    severity: normalizeSeverity(i.severity),
    summary: `Probe ${metric} incident${target}`,
    ref_id: i.id,
  });
  if (i.resolvedAt) {
    const dur = i.durationSeconds != null ? ` after ${i.durationSeconds}s` : '';
    events.push({
      timestamp: toIso(i.resolvedAt),
      source: SOURCES.INCIDENT,
      type: `incident.${metric}.resolved`,
      severity: 'INFO',
      summary: `Probe ${metric} incident resolved${dur}${target}`,
      ref_id: i.id,
    });
  }
  return events;
}

// Only discrete agent LIFECYCLE events belong on the timeline: connect,
// disconnect and enrolment. Recurring activity (traffic/probe reports, deduped
// onto one row) is not an "event" and is skipped.
const AGENT_EVENT_META = {
  'agent.online': { severity: 'INFO', label: 'Agent connected' },
  'agent.offline': { severity: 'WARN', label: 'Agent disconnected' },
  'agent.enrolled': { severity: 'INFO', label: 'Agent enrolled' },
};

function mapAgentEvent(e) {
  if (!e) return [];
  const meta = AGENT_EVENT_META[e.action];
  if (!meta) return [];
  const where = e.ip ? ` from ${e.ip}` : '';
  return [{
    timestamp: toIso(e.ts),
    source: SOURCES.AGENT,
    type: e.action,
    severity: meta.severity,
    summary: `${meta.label}${where}`,
    ref_id: e.id,
  }];
}

function playbookSeverity(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'failed' || s === 'error') return 'WARN';
  return 'INFO';
}

function mapPlaybookRun(r) {
  if (!r) return [];
  const name = r.playbookName || 'Playbook';
  const status = r.status || 'run';
  const detail = r.resultText ? `: ${r.resultText}` : '';
  return [{
    timestamp: toIso(r.ranAt),
    source: SOURCES.PLAYBOOK,
    type: `playbook.${status}`,
    severity: playbookSeverity(status),
    summary: `${name} — ${status}${detail}`,
    ref_id: r.id,
  }];
}

// Merge the four already-fetched source arrays into one timeline, newest first.
// Any source array may be omitted/empty. `limit` (when a positive integer) caps
// the returned events to the most recent N after the merge.
function buildTargetTimeline({
  findings = [],
  incidents = [],
  agentEvents = [],
  playbookRuns = [],
  limit = null,
} = {}) {
  const events = [];
  for (const f of findings) events.push(...mapFinding(f));
  for (const i of incidents) events.push(...mapIncident(i));
  for (const e of agentEvents) events.push(...mapAgentEvent(e));
  for (const r of playbookRuns) events.push(...mapPlaybookRun(r));

  // Drop anything we couldn't assign a timestamp to (a malformed row) rather
  // than emit a null-timestamped event that would sort unpredictably.
  const valid = events.filter((e) => e.timestamp != null);

  valid.sort((a, b) => ms(b.timestamp) - ms(a.timestamp)
    || (SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source])
    || (String(a.ref_id) > String(b.ref_id) ? 1 : String(a.ref_id) < String(b.ref_id) ? -1 : 0));

  if (Number.isInteger(limit) && limit > 0 && valid.length > limit) {
    return valid.slice(0, limit);
  }
  return valid;
}

module.exports = {
  buildTargetTimeline,
  normalizeSeverity,
  mapFinding,
  mapIncident,
  mapAgentEvent,
  mapPlaybookRun,
  SOURCES,
};
