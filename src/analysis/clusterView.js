'use strict';

// Pure read-model assembly for the cross-agent incident-cluster REST API. Turns a
// stored cluster (incidentClustersRepository) plus its hydrated member findings
// into the detail shape the API returns: members, affected agents/targets, a
// suspected root-cause LAYER classification, the confidence breakdown and an
// evidence summary explaining which signals drove the grouping.
//
// No I/O here — the router does the DB reads and passes the objects in — so this
// stays trivially unit-testable, like the rest of the analysis stack.

const { confidenceBreakdown } = require('./crossAgentCorrelator');
// Reuse the L2 (investigation) layer classifiers so "network-layer vs
// application-layer" means exactly the same thing here as in the locator — no
// parallel taxonomy.
const { isAppMetric, isNetMetric } = require('../investigation/locator');

// Suspected root-cause LAYER for the cluster, from its members' metrics — the
// cross-agent counterpart of the per-target correlator's app-vs-net split:
//   * 'network-layer'     — members point at interface/packet-level metrics only,
//   * 'application-layer'  — members point at TCP/app-level metrics only,
//   * 'undetermined'       — mixed signals, or metrics that map to neither.
// Explainable: the reason names the deciding metrics.
function classifyRootCauseLayer(metrics) {
  const list = [...new Set((Array.isArray(metrics) ? metrics : []).filter(Boolean))];
  const net = list.filter(isNetMetric);
  const app = list.filter(isAppMetric);

  let layer = 'undetermined';
  let reason;
  if (net.length && !app.length) {
    layer = 'network-layer';
    reason = `Member metrics are interface/packet-level (${net.join(', ')}).`;
  } else if (app.length && !net.length) {
    layer = 'application-layer';
    reason = `Member metrics are TCP/application-level (${app.join(', ')}).`;
  } else if (app.length && net.length) {
    reason = `Mixed signals — network (${net.join(', ')}) and application (${app.join(', ')}) — cannot attribute a single layer.`;
  } else {
    reason = list.length
      ? `Member metrics (${list.join(', ')}) do not map to a network- or application-layer signal.`
      : 'No member metrics available to classify.';
  }
  return { layer, reason, networkMetrics: net, applicationMetrics: app };
}

// A compact, evidence-bearing member row (never advice without its evidence).
function memberRef(f) {
  return {
    findingId: f.id,
    host: f.hostId ?? null,
    metric: f.metric ?? null,
    severity: f.severity ?? null,
    kind: f.kind ?? null,
    observed: f.observed ?? null,
    baseline: f.baseline ?? null,
    deviation: f.deviation ?? null,
    acked: Boolean(f.acked),
    explanation: f.explanation ?? null,
    evidenceSamples: Array.isArray(f.evidence) ? f.evidence.length : 0,
    createdAt: f.createdAt instanceof Date ? f.createdAt.toISOString() : (f.createdAt ?? null),
  };
}

// Plain-language summary of WHICH signals drove the grouping and why — the
// human-readable companion to the confidence breakdown.
function evidenceSummary(breakdown, hostIds, commonType) {
  const drivers = [];
  if (breakdown.signals.time) drivers.push(`${hostIds.length} agents fired within the correlation window (time proximity)`);
  if (breakdown.signals.topology) drivers.push('the agents share a site (topology)');
  if (breakdown.signals.type && commonType) drivers.push(`≥2 agents reported the same finding-type (${commonType})`);
  return {
    drivers,
    text: drivers.length
      ? `Grouped because ${drivers.join('; ')}.`
      : 'Grouped on time proximity alone.',
  };
}

// Assembles the full cluster-detail payload. `cluster` is a mapped repo row;
// `members` are the hydrated finding objects (in cluster member order, missing
// ones already filtered out by the caller).
function buildClusterDetail(cluster, members = []) {
  const hostIds = [...new Set(members.map((f) => f.hostId).filter((h) => h != null).map(String))];
  const metrics = members.map((f) => f.metric).filter(Boolean);
  const breakdown = confidenceBreakdown(cluster.confidence, members);
  const rootCause = classifyRootCauseLayer(metrics);

  // Recompute the single shared finding-type (if any) for the summary.
  const typeCounts = new Map();
  for (const f of members) {
    if (!f.metric) continue;
    if (!typeCounts.has(f.metric)) typeCounts.set(f.metric, new Set());
    typeCounts.get(f.metric).add(String(f.hostId));
  }
  let commonType = null;
  for (const [metric, hosts] of typeCounts) {
    if (hosts.size >= 2) { commonType = metric; break; }
  }

  return {
    id: cluster.id,
    status: cluster.status,
    confidence: cluster.confidence,
    confidenceBreakdown: breakdown,
    firstSeen: cluster.createdAt,
    lastSeen: cluster.detectedAt,
    acknowledgedAt: cluster.acknowledgedAt ?? null,
    acknowledgedBy: cluster.acknowledgedBy ?? null,
    resolvedAt: cluster.resolvedAt ?? null,
    resolvedBy: cluster.resolvedBy ?? null,
    resolutionNote: cluster.resolutionNote ?? null,
    memberFindingIds: cluster.memberFindingIds,
    members: members.map(memberRef),
    affectedAgents: hostIds,
    affectedTargets: hostIds,
    memberCount: cluster.memberFindingIds.length,
    suspectedRootCause: {
      classification: rootCause.layer,
      reason: rootCause.reason,
      commonCause: cluster.suspectedCommonCause ?? null,
    },
    advisory: cluster.advisory ?? null,
    evidenceSummary: evidenceSummary(breakdown, hostIds, commonType),
  };
}

module.exports = { classifyRootCauseLayer, buildClusterDetail, memberRef, evidenceSummary };
