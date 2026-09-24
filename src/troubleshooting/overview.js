'use strict';

// Pure read-model for the consolidated Troubleshooting Dashboard.
//
// This module owns NO business logic of its own — every input is a read-model
// another domain already produces:
//
//   rootCauses  <- src/analysis/clusterView.js  buildClusterDetail()  (cross-agent correlator)
//                  + the open event cases outside a live situation (single-host faults)
//   blast radius<- src/topology/blastRadius.js  computeBlastRadius()
//   topology    <- src/topology/graph.js        buildTopologyGraph()
//   anomalies   <- analysis findings with metric 'flow.volume' (flowPairBaselineJob)
//   timeline    <- src/timeline/targetTimeline.js buildTargetTimeline()
//
// It only AGGREGATES: it re-keys, joins and counts. Everything here is pure —
// no I/O, no clock, no DB. The fan-out lives in overviewService.js.
//
// Fail-closed on missing data: every builder accepts undefined/null/garbage and
// returns an empty structure rather than throwing. A domain that is down must
// cost the operator that one panel, never the whole screen.

const { normalizeSeverity } = require('../timeline/targetTimeline');
const {
  key: nodeKey, isDevice: isDeviceNode, deviceIdOf, compare: compareNodes, deviceNode,
} = require('../topology/nodeId');
const { deviceState } = require('../topology/deviceNodes');

const SEVERITY_RANK = Object.freeze({ INFO: 1, WARN: 2, CRIT: 3 });

// Node states rendered on the topology panel:
//   ok                     — the agent is reporting in
//   degraded               — reachable, but an open fault sits on it: an
//                            unacknowledged CRIT/WARN finding of a live
//                            situation or an open event case names it (a
//                            switch port down or flapping, a probe outage, a
//                            failed transaction). We can hear it; something
//                            on it is still broken.
//   down                   — the agent is offline (the fault itself)
//   unreachable_downstream — L2-isolated behind a `down` node; we cannot tell
//                            whether it is healthy, only that we cannot hear it.
//                            NEVER a node we CAN hear: an agent that is online
//                            and reporting is reachable by definition, whatever
//                            is offline next to it.
const NODE_STATE = Object.freeze({
  OK: 'ok',
  DEGRADED: 'degraded',
  DOWN: 'down',
  UNREACHABLE_DOWNSTREAM: 'unreachable_downstream',
});

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

// Agent ids travel as strings in some read-models (clusterView keys hosts by
// String(hostId)) and as numbers in others (the topology graph). One coercion
// point keeps the joins honest; anything non-numeric is dropped rather than
// silently becoming NaN.
function toNodeId(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toIso(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Worst severity across a cluster's member findings. `event_clusters` stores
// no severity column of its own — the correlator derives it from the members,
// and so do we (same rule the alert rollup in clusterRollup.js applies).
function worstSeverity(members) {
  let best = null;
  let bestRank = 0;
  for (const m of asArray(members)) {
    const sev = normalizeSeverity(m && m.severity);
    const rank = SEVERITY_RANK[sev] || 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = sev;
    }
  }
  return best;
}

// One-line, human-readable cause. Prefers what the correlator actually
// concluded, then its evidence summary, and only then a generic fallback — we
// never present advice without the evidence that produced it.
function causeText(cluster) {
  const root = (cluster && cluster.suspectedRootCause) || {};
  if (root.commonCause) return String(root.commonCause);
  const evidence = cluster && cluster.evidenceSummary;
  if (evidence && evidence.text) return String(evidence.text);
  if (root.reason) return String(root.reason);
  const n = asArray(cluster && cluster.affectedAgents).length;
  return n ? `Correlated anomalies across ${n} agent(s).` : 'Correlated anomalies.';
}

// Union of a set of nodes' blast radii, expressed as the devices impacted
// BEYOND the ones already named as affected. That subtraction is the whole
// point of the number the operator reads ("→ 2 access-switches unreachable"):
// re-counting the failing devices themselves would inflate every root cause.
//
// `blastByNode` maps nodeId -> computeBlastRadius() output. Missing entries are
// simply skipped (blast radius is best-effort — a topology store that is empty
// or unavailable yields a count of 0, not an error).
function collateBlastRadius(affectedIds, blastByNode) {
  const affected = new Set(affectedIds);
  const isolated = new Set();
  const dependents = new Set();
  const lookup = blastByNode instanceof Map
    ? (id) => blastByNode.get(id)
    : (id) => (blastByNode && typeof blastByNode === 'object' ? blastByNode[id] : undefined);

  for (const id of affectedIds) {
    const radius = lookup(id);
    if (!radius) continue;
    for (const hit of asArray(radius.directly_isolated)) {
      const nodeId = toNodeId(hit && hit.hostId);
      if (nodeId !== null && !affected.has(nodeId)) isolated.add(nodeId);
    }
    for (const hit of asArray(radius.dependency_affected)) {
      const nodeId = toNodeId(hit && hit.hostId);
      if (nodeId !== null && !affected.has(nodeId)) dependents.add(nodeId);
    }
  }

  // A host that is L2-isolated is already counted there; don't double-count it
  // as a service dependent too.
  for (const id of isolated) dependents.delete(id);

  const directlyIsolated = [...isolated].sort((a, b) => a - b);
  const dependencyAffected = [...dependents].sort((a, b) => a - b);
  return {
    directlyIsolated,
    dependencyAffected,
    count: directlyIsolated.length + dependencyAffected.length,
  };
}

// ---------------------------------------------------------------------------
// rootCauses[] — the alarm rollup.
//
// ONE cluster = ONE root cause object, never one per affected device. That
// collapse is already done by the cross-agent correlator (a cluster holds N
// member findings across ≥2 agents); this function preserves it rather than
// re-deriving it, and hangs the blast radius off the result.
//
//   clusters    — buildClusterDetail() outputs (see analysis/clusterView.js)
//   blastByNode — nodeId -> computeBlastRadius() output, or {} when unavailable
//
// Returns, newest-first by lastSeen:
//   { id, severity, cause, affectedDeviceIds[], blastRadiusCount, ... }
// ---------------------------------------------------------------------------
function buildRootCauses(clusters, { blastByNode = new Map() } = {}) {
  const out = [];
  for (const cluster of asArray(clusters)) {
    if (!cluster || cluster.id == null) continue;

    const affectedDeviceIds = [...new Set(
      asArray(cluster.affectedAgents).map(toNodeId).filter((v) => v !== null),
    )].sort((a, b) => a - b);

    const blast = collateBlastRadius(affectedDeviceIds, blastByNode);

    out.push({
      id: cluster.id,
      // Where the cause comes from: a cross-agent situation, or (see
      // buildCaseRootCauses) one host's open event case. The two id spaces
      // overlap, so `clusterId`/`caseId` say which record to open.
      source: 'cluster',
      clusterId: cluster.id,
      caseId: null,
      severity: worstSeverity(cluster.members) || 'INFO',
      cause: causeText(cluster),
      affectedDeviceIds,
      blastRadiusCount: blast.count,
      // --- additive context the panel needs (deep-links, badges, "Show path") ---
      status: cluster.status ?? null,
      confidence: cluster.confidence ?? null,
      classification: (cluster.suspectedRootCause && cluster.suspectedRootCause.classification) ?? null,
      memberCount: cluster.memberCount ?? asArray(cluster.members).length,
      firstSeen: toIso(cluster.firstSeen),
      lastSeen: toIso(cluster.lastSeen),
      // The node to anchor "Show path" / blast-radius drill-down on. Lowest id
      // is arbitrary but STABLE, which is what a deep-link needs.
      primaryDeviceId: affectedDeviceIds.length ? affectedDeviceIds[0] : null,
      blastRadius: {
        directlyIsolated: blast.directlyIsolated,
        dependencyAffected: blast.dependencyAffected,
      },
    });
  }

  return out.sort(compareRootCauses);
}

// Worst first, then most recent — the operator's reading order. The tie-break
// compares ids as strings too: a case cause's id is `case:<n>`, and `a - b`
// over it is NaN, which makes a sort silently do nothing.
function compareRootCauses(a, b) {
  const bySeverity = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (bySeverity !== 0) return bySeverity;
  const byTime = new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
  if (byTime !== 0) return byTime;
  const an = Number(a.id);
  const bn = Number(b.id);
  if (Number.isFinite(an) && Number.isFinite(bn)) return bn - an;
  return String(b.id).localeCompare(String(a.id));
}

// The first sentence of a finding's explanation — "Port Gi0/1 on sw-1 went
// down (SNMP poll)." — which is what the detector concluded, in its own
// words. Bounded so one verbose detector cannot push the row off the panel.
function firstSentence(text, max = 200) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = /^(.+?[.!?])(\s+[A-Z]|$)/s.exec(s);
  const out = (m ? m[1] : s).replace(/\s+/g, ' ');
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

// ---------------------------------------------------------------------------
// rootCauses[] from open EVENT CASES — the single-host half of the rollup.
//
// The cross-agent correlator only forms a cluster from findings on ≥2 agents,
// so a site with ONE agent never has one: its uplink can be down on both
// switches, with probe outages and a failed transaction on top, and the
// cluster path reports nothing. The open event case is where that work
// already lives (eventCaseService groups a host's findings within the
// activity window), so each open case outside a live situation becomes one
// cause here — the same collapse, one level down: N findings -> ONE cause.
//
//   cases        — eventCasesRepo.listOpenOutsideSituations() rows
//   membersByCase— caseId -> the case's findings (light rows), already stripped
//                  of any finding a live cluster counts, so nothing counts twice
//   primaryById  — findingId -> full finding, for the cause text
//   blastByNode  — as buildRootCauses
//
// The ROOT finding is the case's own primary finding (the one that opened it,
// `primary_finding_id`), falling back to its earliest remaining member when
// the primary is gone or counted by a situation. The cause text is that
// finding's first sentence, falling back to the case title.
// A case with no member left is dropped: a live cluster already counts all of
// it, or retention purged it — either way there is nothing to add.
// ---------------------------------------------------------------------------
function buildCaseRootCauses(cases, { membersByCase = new Map(), primaryById = new Map(), blastByNode = new Map() } = {}) {
  const out = [];
  const membersOf = (id) => asArray(membersByCase instanceof Map
    ? (membersByCase.get(Number(id)) ?? membersByCase.get(String(id)))
    : membersByCase && membersByCase[id]);
  const primaryOf = (id) => (primaryById instanceof Map
    ? primaryById.get(String(id))
    : primaryById && primaryById[id]) || null;

  for (const c of asArray(cases)) {
    if (!c || c.id == null) continue;
    const members = membersOf(c.id);
    if (!members.length) continue;

    const root = caseRoot(c, members);
    const full = primaryOf(root && root.id);

    // The host the case is about, then every switch its findings name. A port
    // finding carries the polling agent in hostId AND the switch in deviceId
    // (migration 110) — the switch is what is affected.
    const agents = new Set();
    const devices = new Set();
    const hostAgent = toNodeId(c.hostId);
    if (hostAgent !== null) agents.add(hostAgent);
    for (const m of members) {
      if (m && m.deviceId != null && Number.isInteger(Number(m.deviceId))) devices.add(deviceNode(m.deviceId));
    }
    const agentIds = [...agents].sort((a, b) => a - b);
    const affectedDeviceIds = [...agentIds, ...[...devices].sort(compareNodes)];
    const blast = collateBlastRadius(agentIds, blastByNode);

    const rootDevice = root && root.deviceId != null ? deviceNode(root.deviceId) : null;
    out.push({
      id: `case:${c.id}`,
      source: 'case',
      clusterId: null,
      caseId: Number(c.id),
      severity: worstSeverity(members) || normalizeSeverity(c.severity) || 'INFO',
      cause: firstSentence(full && full.explanation) || String(c.title || `Event #${c.id}`),
      title: c.title ?? null,
      affectedDeviceIds,
      blastRadiusCount: blast.count,
      status: c.status ?? null,
      // A case is one host's findings grouped by time, not a correlation
      // judgement — there is no confidence or layer to report, and inventing
      // one would be advice without evidence.
      confidence: null,
      classification: null,
      memberCount: members.length,
      firstSeen: toIso(c.firstEventAt),
      lastSeen: toIso(c.lastEventAt),
      // "Show path" from the switch the root finding names, else the host.
      primaryDeviceId: rootDevice || (agentIds.length ? agentIds[0] : null),
      primaryFindingId: root ? root.id : null,
      primaryMetric: root ? (root.metric ?? null) : null,
      locationName: c.locationName ?? null,
      blastRadius: {
        directlyIsolated: blast.directlyIsolated,
        dependencyAffected: blast.dependencyAffected,
      },
    });
  }
  return out.sort(compareRootCauses);
}

// The finding a case's cause is named after: its own primary finding (the one
// that opened it) while that is still among the members counted here, else
// the earliest remaining member. One rule, used by the overview and the fault
// list alike, so both name a case's cause the same way.
function caseRoot(c, members) {
  const list = asArray(members).filter(Boolean);
  if (!list.length) return null;
  const primary = c && c.primaryFindingId != null ? String(c.primaryFindingId) : null;
  return (primary && list.find((m) => String(m.id) === primary)) || list[0];
}

// The nodes an OPEN fault sits on — what turns an `ok` node `degraded`.
//
// `findings` are the members of the live situations and open cases (never
// the whole findings table: an acknowledged or closed-out alarm is history).
// Only unacknowledged CRIT/WARN count; INFO is a note, not a fault. A finding
// that names a switch (deviceId) marks the SWITCH, not the agent that polled
// it — the agent is fine, it is the port that is down.
function openFaultNodes(findings) {
  const out = new Set();
  for (const f of asArray(findings)) {
    if (!f || f.acked) continue;
    const sev = normalizeSeverity(f.severity);
    if (sev !== 'CRIT' && sev !== 'WARN') continue;
    if (f.deviceId != null && Number.isInteger(Number(f.deviceId)) && Number(f.deviceId) > 0) {
      out.add(nodeKey(deviceNode(f.deviceId)));
      continue;
    }
    const agent = toNodeId(f.hostId);
    if (agent !== null) out.add(nodeKey(agent));
  }
  return out;
}

// ---------------------------------------------------------------------------
// topology — nodes + links carrying a state, across both layers.
//
// The unified graph (buildTopologyGraph) already carries the two edge types:
//   'l2_link'     -> layer 'l2'  (LLDP adjacency, undirected)
//   'service_dep' -> layer 'l3'  (observed TCP dependency, directed)
//
// Node state is DERIVED, not stored — nothing in the schema records
// "unreachable_downstream". The derivation:
//
//   1. agents.status 'online'  -> ok
//      agents.status 'offline' -> down            (the fault itself)
//      unknown / no agent row  -> ok              (see below)
//   2. every host L2-isolated behind a `down` node, and not itself down,
//      becomes unreachable_downstream — we cannot hear it, which is NOT the
//      same claim as "it is broken".
//
// An unknown status maps to `ok` deliberately: we will not invent a fault we
// have no evidence for. A missing agent row means the graph carries an edge to
// a host we no longer monitor, not that the host failed.
//
// Only tier 1 (directly_isolated) greys a node. Tier 2 (dependency_affected) is
// degraded SERVICE, not lost reachability, and stays on the root-cause panel's
// blast-radius count where it belongs.
//
//   3. a node still `ok` (or a switch not polled yet) that an open fault
//      names becomes `degraded` (see openFaultNodes). Applied AFTER the
//      downstream pass, so it never changes who is reachable: a degraded
//      node is one we can hear.
//
// Link state is the worse of its two endpoints — no new vocabulary.
// ---------------------------------------------------------------------------
const STATE_RANK = Object.freeze({
  [NODE_STATE.OK]: 0,
  [NODE_STATE.DEGRADED]: 1,
  [NODE_STATE.UNREACHABLE_DOWNSTREAM]: 2,
  [NODE_STATE.DOWN]: 3,
});

function stateFromAgentStatus(status) {
  return String(status || '').toLowerCase() === 'offline' ? NODE_STATE.DOWN : NODE_STATE.OK;
}

// Which graph nodes are known to be up — the `isAlive` computeBlastRadius
// takes (src/topology/blastRadius.js). An agent is alive when its row says
// online; a switch when its last poll answered. Everything else (offline,
// never polled, unknown) is not known alive, which is the only thing a blast
// radius may count as cut off.
function aliveFrom(agents = [], devices = []) {
  const alive = new Set();
  for (const a of asArray(agents)) {
    const id = toNodeId(a && a.id);
    if (id !== null && String(a.status || '').toLowerCase() === 'online') alive.add(nodeKey(id));
  }
  for (const d of asArray(devices)) {
    if (d && d.id != null && deviceState(d) === 'ok') alive.add(nodeKey(deviceNode(d.id)));
  }
  return (id) => alive.has(nodeKey(id));
}

function worseState(a, b) {
  return (STATE_RANK[b] || 0) > (STATE_RANK[a] || 0) ? b : a;
}

// The view over the graph: every node with the state it is in.
//
// THE GRAPH HOLDS TWO KINDS OF NODE. An agent's state comes from its row's
// `status`; a switch's comes from its last poll, which is a different question
// with a third answer (`deviceNodes.deviceState` — never polled is not ok).
// Reading an agent's status for a switch would report every switch as offline,
// because no agent row has that id.
function buildTopologyView({
  graph = null, agents = [], devices = [], blastByNode = new Map(), faultNodes = null,
} = {}) {
  const nodes = asArray(graph && graph.nodes);
  const edges = asArray(graph && graph.edges);

  const agentById = new Map();
  for (const a of asArray(agents)) {
    const id = toNodeId(a && a.id);
    if (id !== null) agentById.set(id, a);
  }
  const deviceById = new Map();
  for (const d of asArray(devices)) {
    if (d && d.id != null) deviceById.set(Number(d.id), d);
  }

  // --- 1. base state straight from the agent row, or the device's last poll --
  const state = new Map();
  const out = [];
  for (const n of nodes) {
    if (!n || n.id == null) continue;

    if (isDeviceNode(n.id)) {
      const device = deviceById.get(deviceIdOf(n.id)) || null;
      const key = nodeKey(n.id);
      state.set(key, deviceState(device) || 'unknown');
      out.push({
        id: n.id,
        label: n.label || (device && (device.displayName || device.host)) || String(n.id),
        locationId: n.locationId ?? (device && device.locationId != null ? Number(device.locationId) : null),
        kind: 'device',
        host: n.host || (device && device.host) || null,
        status: null,
        lastSeen: (device && device.lastOkAt) || null,
        lastError: (device && device.lastError) || null,
        state: NODE_STATE.OK, // filled in after the downstream pass
      });
      continue;
    }

    const id = toNodeId(n.id);
    if (id === null) continue;
    const agent = agentById.get(id) || null;
    state.set(nodeKey(id), stateFromAgentStatus(agent && agent.status));
    out.push({
      id,
      label: n.label || (agent && (agent.display_name || agent.hostname)) || `agent ${id}`,
      locationId: agent && agent.location_id != null ? Number(agent.location_id) : null,
      kind: 'agent',
      status: (agent && agent.status) || null,
      lastSeen: toIso(agent && agent.last_seen),
      state: NODE_STATE.OK, // filled in after the downstream pass
    });
  }

  // --- 2. grey out what a `down` node cuts off ----------------------------
  // Only nodes we cannot hear are candidates. The blast radius is a graph walk
  // and the L2 graph is undirected, so from an offline agent it reaches the
  // access switch and every host behind it; that is a statement about what
  // COULD be cut off, not about what is. A node whose own state is `ok` — an
  // agent online and reporting, a switch that answered its poll — is by
  // definition reachable and keeps `ok`. A node already `down` stays `down`
  // (it is a fault in its own right). What remains is a node in `unknown`
  // (a switch never polled): that is the one the radius may grey out.
  const lookup = blastByNode instanceof Map
    ? (id) => (blastByNode.get(id) ?? blastByNode.get(Number(id)))
    : (id) => (blastByNode && typeof blastByNode === 'object' ? blastByNode[id] : undefined);

  for (const [id, s] of state) {
    if (s !== NODE_STATE.DOWN) continue;
    const radius = lookup(id);
    if (!radius) continue;
    for (const hit of asArray(radius.directly_isolated)) {
      if (!hit || hit.hostId == null) continue;
      const hostKey = nodeKey(hit.hostId);
      const current = state.get(hostKey);
      // Never downgrade a node we already know is down, and never mark a node
      // we can hear as unreachable.
      if (current === NODE_STATE.DOWN || current === NODE_STATE.OK) continue;
      state.set(hostKey, NODE_STATE.UNREACHABLE_DOWNSTREAM);
    }
  }

  // --- 2b. an open fault on a node we can hear -----------------------------
  // A switch whose uplink port is down answers its poll perfectly well; so
  // does an agent whose probes are all failing. Painting either green is the
  // screen saying nothing is broken. Only `ok` and `unknown` move: `down` and
  // `unreachable_downstream` already say more.
  const faulted = faultNodes instanceof Set ? faultNodes : new Set(asArray(faultNodes).map(nodeKey));
  for (const k of faulted) {
    const current = state.get(k);
    if (current === NODE_STATE.OK || current === 'unknown') state.set(k, NODE_STATE.DEGRADED);
  }
  for (const node of out) node.state = state.get(nodeKey(node.id)) || NODE_STATE.OK;

  // --- 3. links, tagged by layer, state = worse endpoint ------------------
  const links = [];
  for (const e of edges) {
    if (!e || e.source == null || e.target == null) continue;
    const source = isDeviceNode(e.source) ? e.source : toNodeId(e.source);
    const target = isDeviceNode(e.target) ? e.target : toNodeId(e.target);
    if (source === null || target === null) continue;
    const layer = e.type === 'l2_link' ? 'l2' : 'l3';
    links.push({
      layer,
      type: e.type,
      directed: Boolean(e.directed),
      source,
      target,
      dstPort: e.dstPort != null ? Number(e.dstPort) : null,
      // Which port, when the adjacency came off a switch that knows.
      localIfName: e.localIfName || null,
      remotePortId: e.remotePortId || null,
      state: worseState(state.get(nodeKey(source)) || NODE_STATE.OK, state.get(nodeKey(target)) || NODE_STATE.OK),
    });
  }

  // The three canonical states are always present; `unknown` and `degraded`
  // only when something is in them. A legend entry that always reads 0 is one
  // nobody reads.
  const counts = { ok: 0, down: 0, unreachable_downstream: 0 };
  for (const node of out) {
    if (counts[node.state] === undefined) counts[node.state] = 0;
    counts[node.state] += 1;
  }
  if (!counts.unknown) delete counts.unknown;
  if (!counts.degraded) delete counts.degraded;

  return {
    nodes: out.sort((a, b) => compareNodes(a.id, b.id)),
    links,
    counts,
    layers: {
      l2: links.filter((l) => l.layer === 'l2').length,
      l3: links.filter((l) => l.layer === 'l3').length,
    },
  };
}

// ---------------------------------------------------------------------------
// anomalies[] — per-flow-pair baseline deviations.
//
// These are NOT re-derived here. flowPairBaselineJob already scores each
// (src,dst,port) pair against its day-of-week/hour-of-day median+MAD baseline
// and persists the result as a normal finding with metric 'flow.volume',
// carrying the pair in evidence[0].labels. Reading those findings fleet-wide is
// strictly cheaper and more consistent than fanning out over
// GET /api/topology/flow-baselines?host= per agent — and it means an anomaly
// the operator acks on the Analysis page disappears here too.
//
//   currentVsBaselinePct — signed percentage change against the baseline:
//                          ((observed - baseline) / baseline) * 100.
//                          +150 means "2.5x the usual volume", -80 means the
//                          pair went nearly silent. null when the baseline is
//                          zero or absent (no meaningful ratio exists).
//   since                — the start of the deviating window, falling back to
//                          when the finding was recorded.
// ---------------------------------------------------------------------------
function pairLabels(finding) {
  const first = asArray(finding && finding.evidence)[0];
  const labels = (first && first.labels) || {};
  return {
    src: labels.src != null ? String(labels.src) : null,
    dst: labels.dst != null ? String(labels.dst) : null,
    dstPort: labels.dstPort != null ? Number(labels.dstPort) : null,
  };
}

function percentVsBaseline(observed, baseline) {
  // Guard the nulls BEFORE coercing: Number(null) is 0, which would turn a
  // missing observation into a confident "-100%" ("the pair went silent").
  if (observed == null || baseline == null || observed === '' || baseline === '') return null;
  const o = Number(observed);
  const b = Number(baseline);
  if (!Number.isFinite(o) || !Number.isFinite(b) || b === 0) return null;
  return Math.round(((o - b) / b) * 1000) / 10;
}

function buildAnomalies(findings) {
  const out = [];
  for (const f of asArray(findings)) {
    if (!f) continue;
    const { src, dst, dstPort } = pairLabels(f);
    // Without the pair labels there is no link to name — skip rather than
    // render an "undefined -> undefined" row.
    if (!src || !dst) continue;
    const port = dstPort != null && Number.isFinite(dstPort) ? dstPort : null;
    const windowFrom = Array.isArray(f.window) ? f.window[0] : null;
    out.push({
      linkId: `${src}->${dst}${port != null ? `:${port}` : ''}`,
      currentVsBaselinePct: percentVsBaseline(f.observed, f.baseline),
      since: toIso(windowFrom) || toIso(f.createdAt),
      // --- additive context (deep-link + the evidence behind the number) ---
      findingId: f.id ?? null,
      srcHostId: toNodeId(src),
      dstHostId: toNodeId(dst),
      dstPort: port,
      observed: f.observed ?? null,
      baseline: f.baseline ?? null,
      deviation: f.deviation ?? null,
      severity: normalizeSeverity(f.severity),
      explanation: f.explanation ?? null,
    });
  }
  // Largest absolute swing first — the pair that moved most is the one to look
  // at, whether it spiked or went silent. Unrateable rows sink to the bottom.
  out.sort((a, b) => {
    const av = a.currentVsBaselinePct == null ? -1 : Math.abs(a.currentVsBaselinePct);
    const bv = b.currentVsBaselinePct == null ? -1 : Math.abs(b.currentVsBaselinePct);
    if (av !== bv) return bv - av;
    return new Date(b.since || 0) - new Date(a.since || 0);
  });
  return out;
}

// ---------------------------------------------------------------------------
// summary — the four key-figure cards.
//
//   activeFaults   — raw open alarm signals: the member findings behind the
//                    live root causes — a situation's members, and an open
//                    event case's findings. Paired with `rootCauses` this is
//                    the rollup made visible ("47 alarms -> 3 causes").
//   affectedDevices— the full impact footprint: every device named by a root
//                    cause, everything in its blast radius, and every node the
//                    topology reports as not-ok. Counted once each.
//   rootCauses     — how many distinct causes those alarms collapse to.
//   anomalies      — flow-pair baseline deviations.
// ---------------------------------------------------------------------------
function buildSummary({ rootCauses = [], topology = null, anomalies = [] } = {}) {
  const causes = asArray(rootCauses);
  const devices = new Set();
  let activeFaults = 0;

  for (const rc of causes) {
    activeFaults += Number(rc.memberCount) || 0;
    for (const id of asArray(rc.affectedDeviceIds)) devices.add(id);
    const blast = rc.blastRadius || {};
    for (const id of asArray(blast.directlyIsolated)) devices.add(id);
    for (const id of asArray(blast.dependencyAffected)) devices.add(id);
  }

  const counts = (topology && topology.counts) || { ok: 0, down: 0, unreachable_downstream: 0 };
  for (const n of asArray(topology && topology.nodes)) {
    if (n && n.state && n.state !== NODE_STATE.OK) devices.add(n.id);
  }

  return {
    activeFaults,
    affectedDevices: devices.size,
    rootCauses: causes.length,
    anomalies: asArray(anomalies).length,
    // --- additive breakdown behind `affectedDevices` ---
    devicesDown: Number(counts.down) || 0,
    devicesUnreachable: Number(counts.unreachable_downstream) || 0,
    devicesDegraded: Number(counts.degraded) || 0,
  };
}

module.exports = {
  buildRootCauses,
  buildCaseRootCauses,
  caseRoot,
  compareRootCauses,
  openFaultNodes,
  firstSentence,
  buildTopologyView,
  buildAnomalies,
  buildSummary,
  percentVsBaseline,
  stateFromAgentStatus,
  aliveFrom,
  worseState,
  collateBlastRadius,
  worstSeverity,
  causeText,
  toNodeId,
  toIso,
  asArray,
  NODE_STATE,
  SEVERITY_RANK,
};
