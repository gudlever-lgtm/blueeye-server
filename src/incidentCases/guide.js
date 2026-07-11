'use strict';

// Deterministic, local, explainable troubleshooting guide for an incident — the
// "Guide me" steps. Pure: the route assembles a compact context (incident +
// anomalies + optional config-context + top similar) and this builds an ordered,
// rationale-carrying step list following the standard method (confirm → recent
// change → metric-specific check → correlated signals → prior resolution →
// escalate/document). The opt-in AI assistant augments this in the UI via the
// existing /ask endpoint; the guide itself needs no provider call, so it ALWAYS
// works — AI is assistance, not a dependency.
//
// Each step:
//   { id, title, detail, rationale, kind: 'check'|'action'|'info',
//     action?: { label, view, targetId } }   // action = a UI deep-link into an existing tool

// The primary anomaly type for the incident: the primary finding's metric, else
// the first linked anomaly's.
function primaryMetricOf(incident, anomalies) {
  if (incident && incident.primaryFindingId) {
    const pf = anomalies.find((a) => a.id === incident.primaryFindingId);
    if (pf && pf.metric) return pf.metric;
  }
  return anomalies.length && anomalies[0].metric ? anomalies[0].metric : null;
}

// Tailored check for the metric family. Returns a step (without id) or null.
function metricStep(metric, deviceId) {
  const m = String(metric || '').toLowerCase();
  const traceAction = deviceId != null ? { label: 'Run traceroute / path', view: 'agent', targetId: deviceId } : null;

  if (/reach|loss|packet/.test(m)) {
    return {
      title: 'Localize where packets are lost',
      kind: 'action',
      detail: 'Run a traceroute/path probe to the affected target and find the first hop that shows loss.',
      rationale: 'Reachability / packet-loss anomalies are localized fastest by hop-by-hop path analysis.',
      action: traceAction,
    };
  }
  if (/lat|jitter|rtt/.test(m)) {
    return {
      title: 'Check the path for latency or rerouting',
      kind: 'action',
      detail: 'Compare latency against the baseline and look for a new hop or an AS-path change (rerouting).',
      rationale: 'Latency/jitter spikes often come from a path change; BlueEye tracks AS-path changes on the path map.',
      action: traceAction,
    };
  }
  if (/iface|interface|error|discard|link|crc|duplex/.test(m)) {
    return {
      title: 'Inspect interface counters and link state',
      kind: 'check',
      detail: 'Check errors/discards/CRC and link/duplex on the affected interface.',
      rationale: 'Interface errors/discards point at an L1 issue — duplex mismatch, a failing optic or cable.',
      action: deviceId != null ? { label: 'Open interfaces', view: 'interfaces', targetId: deviceId } : null,
    };
  }
  if (/through|bandwidth|\bbw\b|util|traffic|saturat/.test(m)) {
    return {
      title: 'Check for saturation and top talkers',
      kind: 'check',
      detail: 'Look at interface utilisation and the top talkers/flows for congestion.',
      rationale: 'Throughput anomalies usually mean saturation; the flows show who is driving it.',
      action: deviceId != null ? { label: 'Open flows', view: 'flows', targetId: deviceId } : null,
    };
  }
  if (/cpu|mem|load|system|disk/.test(m)) {
    return {
      title: 'Check device resources',
      kind: 'check',
      detail: 'Review CPU / memory / load and any recent change on the device.',
      rationale: 'Resource exhaustion degrades forwarding and the probes alike, and can masquerade as a network fault.',
    };
  }
  return {
    title: 'Inspect the affected metric against its baseline',
    kind: 'check',
    detail: `Review recent samples for ${metric || 'the metric'} versus its normal range.`,
    rationale: 'Grounds the investigation in the actual deviation before acting.',
  };
}

function buildIncidentGuide({ incident, anomalies = [], configContext = null, similar = [] } = {}) {
  if (!incident) return { incidentId: null, primaryMetric: null, steps: [] };
  const deviceId = incident.deviceId != null ? incident.deviceId : (incident.hostId ?? null);
  const primaryMetric = primaryMetricOf(incident, anomalies);

  const steps = [];
  const add = (s) => { steps.push({ id: `s${steps.length + 1}`, kind: 'check', action: null, ...s }); };

  // 1. Confirm scope — always first.
  add({
    title: 'Confirm the incident is still active',
    kind: 'check',
    detail: `Check the current health of device ${deviceId ?? '(unknown)'} — reachability, loss, latency and interfaces.`,
    rationale: 'Rule out an already-recovered or transient condition before deeper work.',
    action: deviceId != null ? { label: 'Open device health', view: 'agent', targetId: deviceId } : null,
  });

  // 2. Recent config change — the prime suspect when correlated.
  if (configContext && configContext.configChangeId) {
    const risk = configContext.risk || 'unknown';
    const mins = configContext.minutesBefore;
    const reasons = Array.isArray(configContext.riskReasons) ? configContext.riskReasons : [];
    add({
      title: 'Review the correlated config change',
      kind: 'check',
      detail: `A device-config change was captured${mins != null ? ` ${mins} min before onset` : ''} (risk: ${risk}${reasons.length ? `, ${reasons.join(', ')}` : ''}). Review the diff — a recent change is the most common root cause.`,
      rationale: 'BlueEye auto-correlated this change to the incident window; a high-risk change (ACL/routing/interface) is the prime suspect.',
      action: { label: 'View config context', view: 'config-context', targetId: incident.id },
    });
  }

  // 3. Metric-specific check.
  const ms = metricStep(primaryMetric, deviceId);
  if (ms) add(ms);

  // 4. Correlated anomalies.
  const metrics = [...new Set(anomalies.map((a) => a.metric).filter(Boolean))];
  if (anomalies.length > 1) {
    add({
      title: 'Follow the correlated anomalies',
      kind: 'check',
      detail: `${anomalies.length} anomalies fired together (${metrics.join(', ')}). Start from the upstream one.`,
      rationale: 'Concurrent anomalies usually share one root cause; the correlator hints which metric is upstream.',
    });
  }

  // 5. How a similar incident was resolved.
  if (similar && similar.length) {
    const top = similar[0];
    const when = top.resolvedAt ? ` on ${String(top.resolvedAt).slice(0, 10)}` : '';
    add({
      title: 'Check how a similar incident was resolved',
      kind: 'info',
      detail: `This resembles incident #${top.id}${top.title ? ` (“${top.title}”)` : ''}, resolved${when}${top.closedBy ? ` by ${top.closedBy}` : ''}.`,
      rationale: 'A past resolution of a matching incident is often the fastest path to a known fix.',
      action: { label: 'Open similar incident', view: 'incident', targetId: top.id },
    });
  }

  // 6. Document + escalate — always last.
  add({
    title: 'Document findings and escalate if unresolved',
    kind: 'action',
    detail: 'Move the incident to Investigating, note what you checked, and escalate if it persists. A closed incident can be reopened with a comment.',
    rationale: 'Keeps the audit trail and hand-off clear; Investigating also lets BlueEye auto-resolve once anomalies stop.',
  });

  return { incidentId: incident.id, primaryMetric: primaryMetric || null, steps };
}

module.exports = { buildIncidentGuide, metricStep, primaryMetricOf };
