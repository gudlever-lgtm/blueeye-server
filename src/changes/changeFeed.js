'use strict';

// Pure read-model for the "what changed since I last looked" landing page
// (Fase 2). No I/O, no clock, no database — it takes already-fetched rows from
// each source and produces one ordered, grouped feed.
//
// A status dashboard full of green answers a question nobody asked. The shift
// starts with "what happened while I was away", and until now the only way to
// answer that was to open six screens and compare them to memory.
//
// EVENT SHAPE — deliberately the SAME as the target timeline
// (src/timeline/targetTimeline.js) and the topology change feed, so the
// dashboard reuses TimelineView.renderRow instead of growing a second row
// renderer that drifts:
//
//   { timestamp, source, type, severity, summary, ref_id, agentId?, target? }
//
// plus two fields this feed adds:
//   kind        — the UI's grouping/label key ('agent_state', 'finding', …)
//   currentState — true when the row describes a CURRENT condition rather than a
//                  transition observed inside the window (see below)

const SEVERITY_ORDER = ['CRIT', 'WARN', 'INFO'];
const SEVERITY_RANK = { CRIT: 0, WARN: 1, INFO: 2 };

// Normalises the various severity spellings the sources use. Probe incidents say
// warning/critical; findings and topology changes say WARN/CRIT.
function normalizeSeverity(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase();
  if (s === 'CRITICAL' || s === 'CRIT') return 'CRIT';
  if (s === 'WARNING' || s === 'WARN') return 'WARN';
  if (s === 'INFO' || s === 'INFORMATIONAL') return 'INFO';
  return 'INFO';
}

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function makeEvent({ timestamp, source, type, severity, summary, refId = null, agentId = null, kind, currentState = false }) {
  return {
    timestamp: toIso(timestamp),
    source,
    type,
    severity: normalizeSeverity(severity),
    summary,
    ref_id: refId,
    agentId: agentId == null ? null : agentId,
    kind,
    // A row the technician must NOT read as "this happened in your window".
    // Version skew and a missed heartbeat are current conditions: we know the
    // state now, but not when it started, because neither is transition-logged.
    // Saying so is the honest option; inferring a start time would be inventing
    // history, which is precisely what this page must never do.
    currentState,
  };
}

// --- per-source mappers ------------------------------------------------------
// Each takes the rows a repository returned and produces feed events. Kept
// separate (and exported) so each mapping is testable on its own.

// Agent connect/disconnect, from the unified audit trail. This IS a transition
// log — action name carries the direction.
function fromAgentEvents(rows, { nameFor = (id) => `agent ${id}` } = {}) {
  return (rows || []).map((r) => {
    const up = r.action === 'agent.online';
    const enrolled = r.action === 'agent.enrolled';
    const agentId = r.actorId != null ? Number(r.actorId) : null;
    const name = agentId == null ? (r.actorLabel || 'an agent') : nameFor(agentId);
    return makeEvent({
      timestamp: r.lastSeenAt || r.ts,
      source: 'agent',
      type: r.action,
      // A disconnect is actionable; a reconnect is the good news that follows.
      severity: up || enrolled ? 'INFO' : 'WARN',
      summary: enrolled ? `${name} enrolled` : `${name} went ${up ? 'online' : 'offline'}`,
      refId: r.id != null ? Number(r.id) : null,
      agentId,
      kind: 'agent_state',
    });
  });
}

// New anomaly findings.
function fromFindings(rows, { nameFor = (id) => `host ${id}` } = {}) {
  return (rows || []).map((f) => {
    const agentId = Number.isFinite(Number(f.hostId ?? f.host_id)) ? Number(f.hostId ?? f.host_id) : null;
    return makeEvent({
      timestamp: f.createdAt || f.created_at,
      source: 'finding',
      type: `finding.${f.metric}`,
      severity: f.severity,
      summary: `${f.metric} on ${agentId == null ? (f.hostId ?? f.host_id) : nameFor(agentId)}`,
      refId: f.id,
      agentId,
      kind: 'finding',
    });
  });
}

// Probe-outage incidents (migration 025). Each row can contribute TWO events —
// it opened, and (if resolved in the window) it closed. Both matter: "the link
// came back" is exactly as relevant to a handover as "the link went down".
function fromProbeIncidents(rows, { from, to, nameFor = (id) => `agent ${id}` } = {}) {
  const out = [];
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;
  const inWindow = (v) => {
    const t = v ? new Date(v).getTime() : NaN;
    return Number.isFinite(t) && t >= fromMs && t <= toMs;
  };

  for (const i of rows || []) {
    const agentId = i.agentId != null ? Number(i.agentId) : (i.agent_id != null ? Number(i.agent_id) : null);
    const started = i.startedAt || i.started_at;
    const resolved = i.resolvedAt || i.resolved_at;
    const who = agentId == null ? 'an agent' : nameFor(agentId);
    const what = `${i.metric} on ${i.affectedTarget || i.affected_target || 'target'}`;

    if (inWindow(started)) {
      out.push(makeEvent({
        timestamp: started, source: 'incident', type: `incident.${i.metric}.opened`,
        severity: i.severity, summary: `${what} degraded at ${who}`,
        refId: i.id, agentId, kind: 'incident',
      }));
    }
    if (inWindow(resolved)) {
      out.push(makeEvent({
        timestamp: resolved, source: 'incident', type: `incident.${i.metric}.resolved`,
        // A recovery is good news — never surfaced at the severity of the fault
        // it ended, or the page turns red for things that are now fine.
        severity: 'INFO', summary: `${what} recovered at ${who}`,
        refId: i.id, agentId, kind: 'incident',
      }));
    }
  }
  return out;
}

// Incident cases (the operator-facing incident).
function fromIncidentCases(rows) {
  return (rows || []).map((c) => makeEvent({
    timestamp: c.firstEventAt || c.first_event_at,
    source: 'incident_case',
    type: `incident_case.${c.status}`,
    severity: c.severity,
    summary: c.title,
    refId: c.id,
    agentId: Number.isFinite(Number(c.hostId ?? c.host_id)) ? Number(c.hostId ?? c.host_id) : null,
    kind: 'incident',
  }));
}

// Cross-agent clusters ("situations").
function fromClusters(rows) {
  return (rows || []).map((c) => makeEvent({
    timestamp: c.createdAt || c.created_at || c.firstSeenAt,
    source: 'cluster',
    type: `cluster.${c.status}`,
    severity: c.severity || 'WARN',
    summary: c.title || `Situation across ${(c.memberFindingIds || []).length} findings`,
    refId: c.id,
    kind: 'cluster',
  }));
}

// LLDP topology changes — links that appeared or disappeared. Already in the
// timeline event shape, so this only re-labels them for the feed's grouping.
function fromTopologyChanges(rows) {
  return (rows || []).map((t) => makeEvent({
    timestamp: t.timestamp || t.detectedAt || t.detected_at,
    source: 'topology',
    type: t.type || `topology.${t.changeType || t.change_type}`,
    severity: t.severity,
    summary: t.summary,
    refId: t.ref_id != null ? t.ref_id : t.id,
    agentId: t.agentId != null ? Number(t.agentId) : (t.agent_id != null ? Number(t.agent_id) : null),
    kind: 'topology',
  }));
}

// Remediation playbook runs.
function fromPlaybookRuns(rows) {
  return (rows || []).map((r) => makeEvent({
    timestamp: r.ranAt || r.ran_at || r.createdAt,
    source: 'playbook',
    type: `playbook.${r.outcome || 'run'}`,
    // A playbook that failed is a thing someone must pick up; one that
    // succeeded is context.
    severity: String(r.outcome || '').toLowerCase() === 'failed' ? 'WARN' : 'INFO',
    summary: `Playbook "${r.playbookName || r.playbook_name || r.playbookId || 'run'}" ${r.outcome || 'ran'}`,
    refId: r.id,
    kind: 'playbook',
  }));
}

// Device configuration captures.
function fromConfigSnapshots(rows, { nameFor = (id) => `device ${id}` } = {}) {
  return (rows || []).map((c) => {
    const deviceId = c.deviceId != null ? Number(c.deviceId) : (c.device_id != null ? Number(c.device_id) : null);
    return makeEvent({
      timestamp: c.capturedAt || c.captured_at,
      source: 'config',
      type: `config.${c.capturedVia || c.captured_via || 'snapshot'}`,
      severity: 'INFO',
      summary: `Configuration captured on ${deviceId == null ? 'a device' : nameFor(deviceId)}`,
      refId: c.id,
      agentId: deviceId,
      kind: 'config',
    });
  });
}

// --- current-state rows ------------------------------------------------------
// These are NOT transitions. Neither agent version nor heartbeat is
// transition-logged (see docs/changes-feed.md), so we can report the condition
// but not when it began. They are stamped currentState:true and timestamped
// with `now`, and the UI labels them accordingly — an honest "this is true right
// now" beats a fabricated "this changed at 14:02".

function agentHealthRows(agents, { now, serverAgentVersion = null, heartbeatStaleMs = 15 * 60 * 1000 } = {}) {
  const out = [];
  const nowMs = new Date(now).getTime();

  for (const a of agents || []) {
    const name = a.display_name || a.hostname || `agent ${a.id}`;

    // Missed heartbeat: online in the DB but silent for longer than the window.
    const lastSeen = a.last_seen ? new Date(a.last_seen).getTime() : NaN;
    if (Number.isFinite(lastSeen) && nowMs - lastSeen > heartbeatStaleMs) {
      out.push(makeEvent({
        timestamp: now,
        source: 'agent',
        type: 'agent.heartbeat_stale',
        severity: 'WARN',
        summary: `${name} has not reported since ${toIso(a.last_seen)}`,
        refId: Number(a.id),
        agentId: Number(a.id),
        kind: 'agent_health',
        currentState: true,
      }));
    }

    // Version skew against the agent build this server serves.
    const version = a.capabilities && a.capabilities.agentVersion ? String(a.capabilities.agentVersion) : null;
    if (serverAgentVersion && version && version !== serverAgentVersion) {
      out.push(makeEvent({
        timestamp: now,
        source: 'agent',
        type: 'agent.version_skew',
        severity: 'INFO',
        summary: `${name} runs v${version}, this server serves v${serverAgentVersion}`,
        refId: Number(a.id),
        agentId: Number(a.id),
        kind: 'agent_health',
        currentState: true,
      }));
    }
  }
  return out;
}

// --- assembly ----------------------------------------------------------------

// Orders newest-first, with severity breaking a timestamp tie so a CRIT never
// hides under an INFO that happened in the same second.
function compareEvents(a, b) {
  const ta = a.timestamp ? Date.parse(a.timestamp) : NaN;
  const tb = b.timestamp ? Date.parse(b.timestamp) : NaN;
  const va = Number.isFinite(ta);
  const vb = Number.isFinite(tb);
  if (va && vb && ta !== tb) return tb - ta;
  if (va !== vb) return va ? -1 : 1;
  return (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
}

// Drops events outside [from, to]. Applied AFTER mapping rather than relying on
// each repository's own filter, because the sources window differently (some on
// start, some on last-activity) and the page's promise is one consistent window.
//
// currentState rows are exempt: they are stamped `now` and describe the present,
// so a window that ended before `now` must not silently discard them.
function withinWindow(events, { from, to }) {
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;
  return (events || []).filter((e) => {
    if (e.currentState) return true;
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
    return Number.isFinite(t) && t >= fromMs && t <= toMs;
  });
}

// Builds the final feed: filter to the window, order, group by severity, cap.
//
// The cap is applied to the ORDERED list, so what is dropped is always the
// oldest/least severe — and `total` reports what was dropped rather than
// letting a truncated page read as a complete one.
function buildChangeFeed(events, { from, to, limit = 200, offset = 0 } = {}) {
  const ordered = withinWindow(events, { from, to }).sort(compareEvents);
  const page = ordered.slice(offset, offset + limit);

  const groups = SEVERITY_ORDER.map((severity) => ({
    severity,
    events: page.filter((e) => e.severity === severity),
  })).filter((g) => g.events.length > 0);

  return {
    since: toIso(from),
    until: toIso(to),
    groups,
    events: page,
    total: ordered.length,
    returned: page.length,
    offset,
    truncated: ordered.length > offset + page.length,
  };
}

module.exports = {
  SEVERITY_ORDER,
  normalizeSeverity,
  makeEvent,
  compareEvents,
  withinWindow,
  buildChangeFeed,
  fromAgentEvents,
  fromFindings,
  fromProbeIncidents,
  fromIncidentCases,
  fromClusters,
  fromTopologyChanges,
  fromPlaybookRuns,
  fromConfigSnapshots,
  agentHealthRows,
};
