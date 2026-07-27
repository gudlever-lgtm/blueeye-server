'use strict';

// Pure read-model for the consolidated Troubleshooting Dashboard.
//
// This module owns NO business logic of its own — every input is a read-model
// another domain already produces:
//
//   rootCauses  <- src/analysis/clusterView.js  buildClusterDetail()  (cross-agent correlator)
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

const SEVERITY_RANK = Object.freeze({ INFO: 1, WARN: 2, CRIT: 3 });

// Node states rendered on the topology panel:
//   ok                     — the agent is reporting in
//   down                   — the agent is offline (the fault itself)
//   unreachable_downstream — L2-isolated behind a `down` node; we cannot tell
//                            whether it is healthy, only that we cannot hear it
const NODE_STATE = Object.freeze({
  OK: 'ok',
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

// Worst severity across a cluster's member findings. `incident_clusters` stores
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

  // Worst first, then most recent — the operator's reading order.
  out.sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
    if (bySeverity !== 0) return bySeverity;
    const byTime = new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
    if (byTime !== 0) return byTime;
    return Number(b.id) - Number(a.id);
  });
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
// Link state is the worse of its two endpoints — no new vocabulary.
// ---------------------------------------------------------------------------
const STATE_RANK = Object.freeze({
  [NODE_STATE.OK]: 0,
  [NODE_STATE.UNREACHABLE_DOWNSTREAM]: 1,
  [NODE_STATE.DOWN]: 2,
});

function stateFromAgentStatus(status) {
  return String(status || '').toLowerCase() === 'offline' ? NODE_STATE.DOWN : NODE_STATE.OK;
}

function worseState(a, b) {
  return (STATE_RANK[b] || 0) > (STATE_RANK[a] || 0) ? b : a;
}

function buildTopologyView({ graph = null, agents = [], blastByNode = new Map() } = {}) {
  const nodes = asArray(graph && graph.nodes);
  const edges = asArray(graph && graph.edges);

  const agentById = new Map();
  for (const a of asArray(agents)) {
    const id = toNodeId(a && a.id);
    if (id !== null) agentById.set(id, a);
  }

  // --- 1. base state straight from the agent row --------------------------
  const state = new Map();
  const out = [];
  for (const n of nodes) {
    const id = toNodeId(n && n.id);
    if (id === null) continue;
    const agent = agentById.get(id) || null;
    state.set(id, stateFromAgentStatus(agent && agent.status));
    out.push({
      id,
      label: (n && n.label) || (agent && (agent.display_name || agent.hostname)) || `agent ${id}`,
      locationId: agent && agent.location_id != null ? Number(agent.location_id) : null,
      status: (agent && agent.status) || null,
      lastSeen: toIso(agent && agent.last_seen),
      state: NODE_STATE.OK, // filled in after the downstream pass
    });
  }

  // --- 2. grey out what a `down` node cuts off ----------------------------
  const lookup = blastByNode instanceof Map
    ? (id) => blastByNode.get(id)
    : (id) => (blastByNode && typeof blastByNode === 'object' ? blastByNode[id] : undefined);

  for (const [id, s] of state) {
    if (s !== NODE_STATE.DOWN) continue;
    const radius = lookup(id);
    if (!radius) continue;
    for (const hit of asArray(radius.directly_isolated)) {
      const hostId = toNodeId(hit && hit.hostId);
      if (hostId === null) continue;
      // Never downgrade a node we already know is down.
      if (state.get(hostId) === NODE_STATE.DOWN) continue;
      state.set(hostId, NODE_STATE.UNREACHABLE_DOWNSTREAM);
    }
  }
  for (const node of out) node.state = state.get(node.id) || NODE_STATE.OK;

  // --- 3. links, tagged by layer, state = worse endpoint ------------------
  const links = [];
  for (const e of edges) {
    if (!e) continue;
    const source = toNodeId(e.source);
    const target = toNodeId(e.target);
    if (source === null || target === null) continue;
    const layer = e.type === 'l2_link' ? 'l2' : 'l3';
    links.push({
      layer,
      type: e.type,
      directed: Boolean(e.directed),
      source,
      target,
      dstPort: e.dstPort != null ? Number(e.dstPort) : null,
      state: worseState(state.get(source) || NODE_STATE.OK, state.get(target) || NODE_STATE.OK),
    });
  }

  const counts = { ok: 0, down: 0, unreachable_downstream: 0 };
  for (const node of out) counts[node.state] += 1;

  return {
    nodes: out.sort((a, b) => a.id - b.id),
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
//                    live root causes. Paired with `rootCauses` this is the
//                    rollup made visible ("47 alarms -> 3 causes").
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
  };
}

module.exports = {
  buildRootCauses,
  buildTopologyView,
  buildAnomalies,
  buildSummary,
  percentVsBaseline,
  stateFromAgentStatus,
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
