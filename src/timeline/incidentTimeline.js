'use strict';

// Pure read-model for the cross-agent INCIDENT-CLUSTER timeline (Fase 2 —
// "Incident Situation View"). Merges rows already read from existing sources
// into ONE chronological event stream spanning the cluster's affected agents,
// and splits out the "what changed just before" pre-incident events.
//
// It builds on the per-target timeline (targetTimeline.js): the finding /
// incident / agent-event / playbook-run mappers are reused verbatim, then each
// event is tagged with the `target` (agent id) it belongs to — the one field a
// multi-agent cluster timeline needs that the per-target one doesn't. Two extra
// sources the situation view needs are added here: config-change captures and
// the cluster's own lifecycle (state) transitions.
//
// No storage, no I/O: the service (incidentTimelineService.js) fetches the rows
// and hands them here.
//
// Normalised event shape:
//   { timestamp, source, target, type, severity, summary, ref_id }
//     source — finding | incident | agent | playbook | config | status
//     target — the agent id the event concerns (null for cluster-level status)

const {
  mapFinding, mapIncident, mapAgentEvent, mapPlaybookRun,
  SOURCES,
} = require('./targetTimeline');

// Cluster timeline adds sources on top of the per-target ones.
const CLUSTER_SOURCES = Object.freeze({
  ...SOURCES,
  CONFIG: 'config',
  STATUS: 'status',
  VERIFICATION: 'verification',
  EVIDENCE: 'evidence',
});

// Sources c–e in the requirement: playbook executions (c), agent
// connect/disconnect/upgrade (d) and config changes (e). These are the events
// the "what changed" panel surfaces when they land in the pre-incident window.
const PRE_INCIDENT_SOURCES = new Set([
  CLUSTER_SOURCES.PLAYBOOK, CLUSTER_SOURCES.AGENT, CLUSTER_SOURCES.CONFIG,
]);

const SOURCE_ORDER = { finding: 0, incident: 1, agent: 2, playbook: 3, config: 4, status: 5, verification: 6, evidence: 7 };

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function ms(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// Stamp a set of already-mapped events with the agent (target) they concern.
function withTarget(events, target) {
  const t = target == null ? null : String(target);
  return events.map((e) => ({ ...e, target: t }));
}

// A config-change capture (config_snapshots row). Metadata only — the marker
// that a change happened + how it was captured, deep-linking to the device.
function mapConfigChange(c) {
  if (!c) return [];
  const via = c.capturedVia ? ` (${c.capturedVia})` : '';
  return [{
    timestamp: toIso(c.capturedAt),
    source: CLUSTER_SOURCES.CONFIG,
    type: 'config.change',
    severity: 'INFO',
    summary: `Configuration change captured${via}`,
    ref_id: c.id,
  }];
}

// A cluster lifecycle transition (hash-chained audit_log row, category
// 'incident'): open→acknowledged, →resolved, etc. This is the state-transition
// signal available for a cluster (findings carry no per-finding transition log).
function mapStatusChange(s) {
  if (!s) return [];
  const detail = s.detail || s.action || 'state change';
  const action = s.action || 'change';
  return [{
    timestamp: toIso(s.createdAt ?? s.created_at),
    source: CLUSTER_SOURCES.STATUS,
    type: `status.${action}`,
    severity: 'INFO',
    summary: detail,
    ref_id: s.id,
  }];
}

// A post-remediation verification run (verification_runs row). A completed run
// surfaces its outcome at completed_at (passed=INFO, failed/error=WARN); a still
// pending run surfaces a "scheduled, re-check due" marker at executed_at. Carries
// `suggestResolve` on a pass so the UI can hint (never auto-resolves).
function mapVerification(v) {
  if (!v) return [];
  const status = v.status || 'pending';
  if (status === 'pending') {
    return [{
      timestamp: toIso(v.executedAt),
      source: CLUSTER_SOURCES.VERIFICATION,
      type: 'verification.pending',
      severity: 'INFO',
      summary: `Verification scheduled — re-check due ${toIso(v.dueAt) || 'after settle'}`,
      ref_id: v.id,
      suggestResolve: false,
    }];
  }
  const passed = status === 'passed';
  const readings = Array.isArray(v.readings) ? v.readings : [];
  const summary = passed
    ? 'Verification passed — original symptoms cleared. Resolution suggested.'
    : status === 'failed'
      ? `Verification failed — symptoms persist${readings.length ? ` (${[...new Set(readings.map((r) => r.metric))].join(', ')})` : ''}.`
      : 'Verification could not run (re-check error).';
  return [{
    timestamp: toIso(v.completedAt) || toIso(v.executedAt),
    source: CLUSTER_SOURCES.VERIFICATION,
    type: `verification.${status}`,
    severity: passed ? 'INFO' : 'WARN',
    summary,
    ref_id: v.id,
    suggestResolve: passed,
  }];
}

// An evidence snapshot (cluster_evidence_snapshots row): "evidence snapshot
// captured" per target, linking (ref_id = snapshot id) to the raw-text viewer.
// A partial/offline/failed capture is surfaced (WARN) — never a silent gap.
function mapEvidenceSnapshot(s) {
  if (!s) return [];
  const status = s.status || 'pending';
  const ok = status === 'complete';
  const okItems = (Array.isArray(s.items) ? s.items : []).filter((i) => i && i.status === 'ok').length;
  const total = Array.isArray(s.items) ? s.items.length : 0;
  const summary = status === 'agent-offline'
    ? `Evidence snapshot skipped — agent ${s.target} offline`
    : `Evidence snapshot captured on ${s.target} — ${status}${total ? ` (${okItems}/${total} read-only items)` : ''}`;
  return [{
    timestamp: toIso(s.capturedAt),
    source: CLUSTER_SOURCES.EVIDENCE,
    target: s.target != null ? String(s.target) : null,
    type: `evidence.${status}`,
    severity: ok ? 'INFO' : 'WARN',
    summary,
    ref_id: s.id,
  }];
}

// Sort newest-first, breaking ties by source then ref for deterministic output.
function sortEvents(events) {
  return events.slice().sort((a, b) => ms(b.timestamp) - ms(a.timestamp)
    || ((SOURCE_ORDER[a.source] ?? 9) - (SOURCE_ORDER[b.source] ?? 9))
    || (String(a.ref_id) > String(b.ref_id) ? 1 : String(a.ref_id) < String(b.ref_id) ? -1 : 0));
}

// Build the merged cluster timeline + the "what changed" pre-incident slice.
//
//   memberFindings — the cluster's member finding objects (source a). Each is
//                    tagged with its own hostId as the target.
//   agentSources   — [{ agentId, agentEvents, playbookRuns, incidents,
//                    configChanges }] per affected agent.
//   statusChanges  — the cluster's lifecycle transitions (source b).
//   firstFindingAt — the cluster's earliest member finding time (the incident
//                    onset); the "what changed" window ends here.
//   lookbackMs     — how far before firstFindingAt the pre-incident window opens.
//
// Returns { events, whatChanged } where `events` is the full window timeline
// (newest-first) and `whatChanged` is the sources-c–e events in
// [firstFindingAt - lookbackMs, firstFindingAt) (newest-first). `whatChanged`
// events are a flagged subset — they also remain in `events`.
function buildIncidentTimeline({
  memberFindings = [],
  agentSources = [],
  statusChanges = [],
  verifications = [],
  evidenceSnapshots = [],
  firstFindingAt = null,
  lookbackMs = 30 * 60 * 1000,
} = {}) {
  const events = [];

  for (const f of memberFindings) {
    if (f) events.push(...withTarget(mapFinding(f), f.hostId));
  }
  for (const src of agentSources) {
    const agentId = src && src.agentId;
    for (const e of (src && src.agentEvents) || []) events.push(...withTarget(mapAgentEvent(e), agentId));
    for (const r of (src && src.playbookRuns) || []) events.push(...withTarget(mapPlaybookRun(r), agentId));
    for (const i of (src && src.incidents) || []) events.push(...withTarget(mapIncident(i), agentId));
    for (const c of (src && src.configChanges) || []) events.push(...withTarget(mapConfigChange(c), agentId));
  }
  // Cluster lifecycle transitions + verification runs are not tied to a single agent.
  for (const s of statusChanges) events.push(...withTarget(mapStatusChange(s), null));
  for (const v of verifications) events.push(...withTarget(mapVerification(v), null));
  for (const s of evidenceSnapshots) events.push(...mapEvidenceSnapshot(s)); // already carry target

  const valid = sortEvents(events.filter((e) => e.timestamp != null));

  // "What changed": sources c–e in the pre-incident lookback window.
  let whatChanged = [];
  if (firstFindingAt != null) {
    const onset = ms(firstFindingAt);
    const windowStart = onset - lookbackMs;
    whatChanged = valid.filter((e) => {
      if (!PRE_INCIDENT_SOURCES.has(e.source)) return false;
      const t = ms(e.timestamp);
      return t >= windowStart && t < onset;
    });
  }

  return { events: valid, whatChanged };
}

module.exports = {
  buildIncidentTimeline,
  mapConfigChange,
  mapStatusChange,
  mapVerification,
  mapEvidenceSnapshot,
  CLUSTER_SOURCES,
  PRE_INCIDENT_SOURCES,
};
