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

module.exports = {
  buildRootCauses,
  collateBlastRadius,
  worstSeverity,
  causeText,
  toNodeId,
  toIso,
  asArray,
  NODE_STATE,
  SEVERITY_RANK,
};
