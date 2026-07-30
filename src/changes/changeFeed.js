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
// plus the fields this feed adds:
//   kind        — the UI's grouping/label key ('agent_state', 'event', …)
//   currentState — true when the row describes a CURRENT condition rather than a
//                  transition observed inside the window (see below)
//   metric      — the anomaly type behind the row, when there is one. Carried so
//                 correlation can key on the CONDITION rather than on the record.
//   family      — the condition family the metric belongs to (see
//                 ./indications.js); what the UI turns into "what this indicates".
//   count       — how many raw occurrences this row stands for (1 when it stands
//                 for itself). See correlateEvents() below.
//   firstAt     — timestamp of the OLDEST occurrence folded into this row; equal
//                 to `timestamp` when count === 1.
//   refIds      — every source record id folded into the row, newest first, so a
//                 collapsed row can still be drilled into.
//   findingCount — anomalies rolled up into an event row (0 when none).

const { metricFamily } = require('./indications');

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

function makeEvent({
  timestamp, source, type, severity, summary, refId = null, agentId = null, kind,
  currentState = false, metric = null, findingCount = 0, caseId = null,
}) {
  const ts = toIso(timestamp);
  return {
    timestamp: ts,
    source,
    type,
    severity: normalizeSeverity(severity),
    summary,
    ref_id: refId,
    agentId: agentId == null ? null : agentId,
    kind,
    // The condition this row is about, and what that condition indicates. Both
    // null for rows that aren't about a metric (an agent reconnecting, a config
    // capture) — a family we cannot determine is left null rather than guessed.
    metric: metric == null ? null : String(metric),
    family: metricFamily(metric),
    // Correlation bookkeeping. A row starts out standing for exactly itself;
    // correlateEvents() is what raises `count` and widens `firstAt`.
    count: 1,
    firstAt: ts,
    refIds: refId == null ? [] : [refId],
    findingCount,
    // The incident_case a finding belongs to, when it has one. Internal to the
    // roll-up below and stripped before the feed is returned.
    caseId: caseId == null ? null : Number(caseId),
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

// New anomaly findings. These are the RAW detections: most of them belong to an
// event (incident_case) that already represents them, and correlateEvents() folds
// those away — `caseId` is the link that makes that possible.
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
      metric: f.metric,
      caseId: f.incidentCaseId ?? f.incident_case_id ?? null,
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
        timestamp: started, source: 'probe', type: `probe.${i.metric}.degraded`,
        severity: i.severity, summary: `${what} degraded at ${who}`,
        refId: i.id, agentId, kind: 'probe', metric: i.metric,
      }));
    }
    if (inWindow(resolved)) {
      out.push(makeEvent({
        timestamp: resolved, source: 'probe', type: `probe.${i.metric}.recovered`,
        // A recovery is good news — never surfaced at the severity of the fault
        // it ended, or the page turns red for things that are now fine.
        severity: 'INFO', summary: `${what} recovered at ${who}`,
        refId: i.id, agentId, kind: 'probe', metric: i.metric,
      }));
    }
  }
  return out;
}

// Events — the operator-facing unit (the `incident_cases` table). One event
// already stands for the anomalies that fired on its device inside a correlation
// window, which is why correlateEvents() folds those anomalies INTO this row
// instead of listing them beside it. An event is what an ITSM incident gets
// opened FROM; it is not itself the incident.
function fromEvents(rows) {
  return (rows || []).map((c) => makeEvent({
    // The event is timestamped by its LATEST activity, not its first: a feed
    // ordered newest-first must sort a still-escalating event by when it last
    // did something. `firstAt` keeps the start, so the span is not lost.
    timestamp: c.lastEventAt || c.last_event_at || c.firstEventAt || c.first_event_at,
    source: 'event',
    type: `event.${c.status}`,
    severity: c.severity,
    summary: c.title,
    refId: c.id,
    agentId: Number.isFinite(Number(c.hostId ?? c.host_id)) ? Number(c.hostId ?? c.host_id) : null,
    kind: 'event',
    // Supplied by incidentCasesRepository.list() (joined off primary_finding_id).
    // Absent for a case whose primary finding was deleted — the row still renders,
    // it just carries no "what this indicates" line.
    metric: c.primaryMetric ?? c.primary_metric ?? null,
  })).map((e, i) => {
    const row = rows[i];
    // Preserve the case's own start, so a long-running event reads as "since
    // 07:15" rather than pretending it began at its latest activity.
    const first = toIso(row.firstEventAt || row.first_event_at);
    return {
      ...e,
      ...(first ? { firstAt: first } : {}),
      // Roll-up plumbing (stripped before the feed is returned).
      primaryFindingId: row.primaryFindingId ?? row.primary_finding_id ?? null,
    };
  });
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

// Interface state transitions (migration 075). This is the dimension the feed
// could not report before interfaces were given a transition log — and the one a
// technician asks about most.
function fromInterfaceTransitions(rows, { nameFor = (id) => `agent ${id}` } = {}) {
  return (rows || []).map((t) => {
    const agentId = t.agentId != null ? Number(t.agentId) : null;
    const where = agentId == null ? '' : ` on ${nameFor(agentId)}`;
    return makeEvent({
      timestamp: t.detectedAt || t.detected_at,
      source: 'interface',
      type: t.flapping ? 'interface.flapping' : `interface.${t.toStatus || t.to_status}`,
      severity: t.severity,
      summary: `${t.summary}${where}`,
      refId: t.id,
      agentId,
      kind: 'interface_state',
    });
  });
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

// --- correlation -------------------------------------------------------------
// The feed's job is to answer "what happened", and a hundred rows describing six
// conditions does not answer it. Two reductions run before ordering, in this
// order, and both are lossless in the only sense that matters: nothing is hidden
// without saying so on the row that absorbed it.
//
//   1. ROLL UP  — an anomaly whose event is also on the feed is folded into that
//                 event. The event exists precisely to represent those anomalies;
//                 listing both is double-counting the same detection, which is
//                 what made the page read as twice as busy as reality.
//   2. COLLAPSE — occurrences of the SAME condition on the SAME device are folded
//                 into one row carrying `count`, `firstAt` and every `refIds`.
//                 A latency event that reopened seven times in four hours is one
//                 chronic problem, and saying "7× since 07:15" states that
//                 outright — where seven separate rows only implied it.
//
// Neither reduction crosses a device, a condition, a severity or a transition
// direction, so "went offline" can never be folded into "came back online".

// The event ids present on the feed, plus the primary findings they were built
// from. Both are roll-up signals: the FK is the reliable one, and the primary-
// finding id catches a finding whose FK has not been written yet (the case is
// created from the finding, so a race is possible on the very first anomaly).
function eventAnchors(events) {
  const caseIds = new Set();
  const primaryFindingIds = new Set();
  for (const e of events) {
    if (e.kind !== 'event') continue;
    if (e.ref_id != null) caseIds.add(Number(e.ref_id));
    if (e.primaryFindingId != null) primaryFindingIds.add(String(e.primaryFindingId));
  }
  return { caseIds, primaryFindingIds };
}

// Step 1. Drops anomaly rows already represented by an event row on this feed and
// counts them onto that event. An anomaly whose event fell OUTSIDE the window (or
// which has no event at all) is kept — it is the only row that would report it.
function rollUpFindings(events) {
  const { caseIds, primaryFindingIds } = eventAnchors(events);
  if (caseIds.size === 0 && primaryFindingIds.size === 0) return events;

  const rolledInto = new Map(); // caseId -> anomalies folded in
  const kept = events.filter((e) => {
    if (e.kind !== 'finding') return true;
    const cid = e.caseId == null ? null : Number(e.caseId);
    const byFk = cid != null && caseIds.has(cid);
    const byPrimary = e.ref_id != null && primaryFindingIds.has(String(e.ref_id));
    if (!byFk && !byPrimary) return true;
    if (cid != null) rolledInto.set(cid, (rolledInto.get(cid) || 0) + 1);
    return false;
  });

  return kept.map((e) => {
    if (e.kind !== 'event' || e.ref_id == null) return e;
    const n = rolledInto.get(Number(e.ref_id)) || 0;
    return n ? { ...e, findingCount: e.findingCount + n } : e;
  });
}

// The identity of the CONDITION a row describes — what step 2 groups on.
//
// `type` is part of the key on purpose: it carries both the metric and the
// direction of the transition, so an open never merges with a resolve and a
// disconnect never merges with a reconnect. Severity is in the key so an
// escalation from WARN to CRIT stays visible as its own row rather than being
// absorbed into the milder one.
function correlationKey(e) {
  return [
    e.kind,
    e.source,
    e.type,
    e.agentId == null ? '-' : e.agentId,
    e.metric == null ? '-' : e.metric,
    e.severity,
  ].join('|');
}

// Kinds where a repeat is the SAME ongoing story and folding it is the honest
// summary. Everything else (a config capture, a topology change, a playbook run)
// is a distinct artifact each time it happens and is never folded — you would be
// hiding three separate pushes behind one row.
const COLLAPSIBLE_KINDS = new Set(['event', 'finding', 'probe', 'interface_state', 'agent_state']);

// Step 2. Folds repeats of one condition into a single newest-first row.
//
// currentState rows are never folded: there is one per condition per agent
// already, and they are all stamped `now`, so a count would be meaningless.
function collapseRecurring(events) {
  const groups = new Map();
  const out = [];

  for (const e of events) {
    if (e.currentState || !COLLAPSIBLE_KINDS.has(e.kind)) { out.push(e); continue; }
    const key = correlationKey(e);
    const seen = groups.get(key);
    if (!seen) {
      const row = { ...e };
      groups.set(key, row);
      out.push(row);
      continue;
    }
    // Fold into the row we already have. The surviving row keeps the NEWEST
    // timestamp (the condition's latest activity) and the OLDEST firstAt (when it
    // started) — together, the span the count happened over.
    seen.count += e.count;
    seen.findingCount += e.findingCount;
    const eTs = e.timestamp ? Date.parse(e.timestamp) : NaN;
    const sTs = seen.timestamp ? Date.parse(seen.timestamp) : NaN;
    if (Number.isFinite(eTs) && (!Number.isFinite(sTs) || eTs > sTs)) {
      seen.timestamp = e.timestamp;
      // The newest occurrence's wording wins, so a collapsed row describes the
      // condition as it stands now.
      seen.summary = e.summary;
      seen.ref_id = e.ref_id;
    }
    const eFirst = e.firstAt ? Date.parse(e.firstAt) : NaN;
    const sFirst = seen.firstAt ? Date.parse(seen.firstAt) : NaN;
    if (Number.isFinite(eFirst) && (!Number.isFinite(sFirst) || eFirst < sFirst)) seen.firstAt = e.firstAt;
    // Newest-first, capped: the drill-down needs the recent ones, and an
    // unbounded array on a flapping condition would bloat every response.
    if (e.ref_id != null) seen.refIds = [...new Set([...seen.refIds, ...e.refIds])].slice(0, 50);
  }

  return out;
}

// Both reductions, in order. Exported so each is testable and so a caller that
// genuinely wants the raw stream (an export, an audit) can skip it.
function correlateEvents(events) {
  return collapseRecurring(rollUpFindings(Array.isArray(events) ? events : []));
}

// `caseId` and `primaryFindingId` are roll-up plumbing, not part of the feed's
// contract — dropped so the response describes only what the UI renders.
function stripInternals(e) {
  const { caseId, primaryFindingId, ...rest } = e;
  return rest;
}

// Builds the final feed: filter to the window, order, group by severity, cap.
//
// The cap is applied to the ORDERED list, so what is dropped is always the
// oldest/least severe — and `total` reports what was dropped rather than
// letting a truncated page read as a complete one.
//
// Correlation (roll-up + collapse) runs on the WINDOWED set, before ordering and
// before the cap. That order matters: correlating first means the cap spends its
// budget on distinct conditions instead of on repeats of one, so a single
// flapping link can no longer push every other condition off the page. Pass
// `correlate: false` for the raw stream.
//
// `total` counts feed ROWS (post-correlation) so it stays consistent with
// pagination; `rawTotal` reports the occurrences behind them, and the difference
// between the two is what the page tells the reader it folded.
function buildChangeFeed(events, { from, to, limit = 200, offset = 0, correlate = true } = {}) {
  const windowed = withinWindow(events, { from, to });
  const rows = correlate ? correlateEvents(windowed) : windowed;
  const ordered = rows.sort(compareEvents).map(stripInternals);
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
    rawTotal: windowed.length,
    correlated: windowed.length - ordered.length,
    returned: page.length,
    offset,
    truncated: ordered.length > offset + page.length,
  };
}

module.exports = {
  SEVERITY_ORDER,
  COLLAPSIBLE_KINDS,
  normalizeSeverity,
  makeEvent,
  compareEvents,
  withinWindow,
  correlationKey,
  rollUpFindings,
  collapseRecurring,
  correlateEvents,
  buildChangeFeed,
  fromAgentEvents,
  fromFindings,
  fromProbeIncidents,
  fromEvents,
  fromClusters,
  fromTopologyChanges,
  fromInterfaceTransitions,
  fromPlaybookRuns,
  fromConfigSnapshots,
  agentHealthRows,
};
