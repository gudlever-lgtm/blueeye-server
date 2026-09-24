'use strict';

const crypto = require('crypto');
const { MAX_REFIRE_COOLDOWN_MS } = require('../eventCases/activityWindow');

// Pure helpers for transaction alerting: phase → human-readable diagnosis, baseline
// deviation classification, threshold evaluation, and the FINDING a crossed
// threshold becomes. All I/O (baseline lookups, cross-check, Mistral, the
// finding sink) lives in the caller (src/ws/agentSocket.js); everything here is
// pure and unit-testable.
//
// A crossed threshold is a finding, not a bare alert. It used to be handed
// straight to the alert dispatcher: no finding was stored, no event case
// opened, nothing reached the integrations, and the cross-agent correlator
// never saw it. It now leaves through the same sink as every rule-based
// finding (src/devices/findingSink.js: store → publish → event case → alert →
// integrations), so it is alerted exactly once, by that path.

// How long the same (agent, test, condition) is held back before it is raised
// again while it persists. Inside the event-case activity window with slack,
// so a transaction that keeps failing stays ONE event case instead of opening
// a new one after every quiet stretch (see ../eventCases/activityWindow.js).
const TRANSACTION_REFIRE_MS = MAX_REFIRE_COOLDOWN_MS;

// Failure-phase → human-readable diagnosis. Mirrored in the dashboard
// (public/app.js) so alert text and UI diagnosis read identically.
const PHASE_LABELS = {
  dns: 'DNS lookup failed — the hostname could not be resolved',
  connect: 'TCP connection failed — network, firewall, or host down',
  tls: 'TLS handshake failed — certificate or protocol problem',
  http_status: 'Unexpected HTTP status code',
  keyword: 'Response was missing the expected content',
  timeout: 'The step timed out',
};

const MIN_BASELINE_SAMPLES = 20; // below this, no deviation verdict
const DEVIATION_K = 3;           // > K MAD from the median counts as a deviation

// The steps a result touches (so the caller can fetch their baselines). step 0 =
// whole-test latency; steps 1..N map to step_timings[0..N-1].
function stepsOf(result) {
  const steps = [];
  if (result && result.latency_ms != null) steps.push(0);
  if (result && Array.isArray(result.step_timings)) result.step_timings.forEach((v, i) => { if (v != null) steps.push(i + 1); });
  return steps;
}

// Classifies latency deviation vs. baselines. `baselines` = Map step ->
// { median_ms, mad_ms, sample_count }. Returns { deviation, step } — deviation is
// 'slower' | 'faster' | null; step is the most-deviating step.
function classifyDeviation({ baselines, result }) {
  if (!baselines || baselines.size === 0 || !result) return { deviation: null, step: null };
  const samples = [];
  if (result.latency_ms != null) samples.push([0, result.latency_ms]);
  if (Array.isArray(result.step_timings)) result.step_timings.forEach((v, i) => { if (v != null) samples.push([i + 1, v]); });
  let best = null;
  for (const [step, value] of samples) {
    const b = baselines.get(step);
    if (!b || b.sample_count < MIN_BASELINE_SAMPLES || !b.mad_ms) continue;
    const z = (value - b.median_ms) / b.mad_ms;
    if (Math.abs(z) <= DEVIATION_K) continue;
    if (!best || Math.abs(z) > Math.abs(best.z)) best = { step, deviation: z > 0 ? 'slower' : 'faster', z };
  }
  return best ? { deviation: best.deviation, step: best.step } : { deviation: null, step: null };
}

// Template diagnosis — the Mistral fallback. Uses the agent's structured
// detail.phase, the deviation, and the cross-check scope.
function diagnoseText({ test, agentId, result, deviation, deviationStep, crosscheck }) {
  const detail = result && result.detail && typeof result.detail === 'object' ? result.detail : {};
  const stepIdx = detail.step != null ? detail.step : deviationStep;
  const stepPart = stepIdx != null ? ` (step ${stepIdx})` : '';
  let head;
  if (result.status === 'ok') {
    head = deviation ? `Latency significantly ${deviation === 'slower' ? 'above' : 'below'} baseline` : 'OK';
  } else {
    head = PHASE_LABELS[detail.phase] || `Failed (${result.status})`;
    // The raw facts behind the sentence, always: which phase failed and the
    // errno the agent saw. A label without them cannot be checked.
    const facts = [];
    if (detail.phase) facts.push(`phase ${detail.phase}`);
    if (detail.errno) facts.push(`errno ${detail.errno}`);
    if (facts.length) head += ` (${facts.join(', ')})`;
  }
  let scope = '';
  if (crosscheck) {
    const of = Number.isInteger(crosscheck.total) && crosscheck.total > 0
      ? ` (${crosscheck.failing} of ${crosscheck.total} assigned agents failing)` : '';
    if (crosscheck.scope === 'system') {
      scope = ` — all assigned agents fail: the system is down${of}`;
    } else if (Number(crosscheck.failing) > 1) {
      scope = ` — agent ${agentId} and others fail while the rest succeed: problem from the failing agents' sites/networks${of}`;
    } else {
      scope = ` — only agent ${agentId} fails: problem from this agent's site/network${of}`;
    }
  }
  return `Transaction test "${test.name}"${stepPart}: ${head}${scope}`;
}

// The finding a crossed threshold becomes. `explanation` is the deterministic
// diagnosis (phase, errno and the site-vs-system verdict are always in it);
// an optional assistant text is appended after it, never instead of it.
// The evidence carries the same facts structured, with `testId` — which is
// what the cross-agent correlator keys a transaction finding's SUBJECT on, so
// one test failing from several agents becomes one situation.
function buildTransactionFinding({ test, agentId, result, verdict, crosscheck = null, explanation, assistantText = null, at = new Date() }) {
  const detail = result && result.detail && typeof result.detail === 'object' ? result.detail : {};
  const hostId = String(agentId);
  const observed = result.latency_ms != null ? Number(result.latency_ms) : null;
  const thr = (test && test.config && test.config.thresholds) || {};
  const baseline = verdict.metric === 'transaction.latency' && Number.isFinite(thr.latency_ms) ? thr.latency_ms : null;
  return {
    id: crypto.randomUUID(),
    hostId,
    deviceId: null,
    interfaceId: null,
    metric: verdict.metric,
    severity: verdict.severity,
    // Crossed a configured threshold (fails in a row / a latency limit / a
    // deviation rule). The store's ENUM has no transaction kinds.
    kind: 'THRESHOLD',
    observed,
    baseline,
    deviation: null,
    window: [at, at],
    explanation: assistantText ? `${explanation}\nAssistant: ${assistantText}` : explanation,
    evidence: [{
      hostId,
      metric: verdict.metric,
      value: observed != null ? observed : (result.status === 'ok' ? 0 : 1),
      ts: at,
      testId: test.id,
      testName: test.name,
      testType: test.type || null,
      agentId: Number(agentId),
      status: result.status,
      phase: detail.phase || null,
      errno: detail.errno || null,
      step: detail.step != null ? detail.step : (result._deviationStep ?? null),
      latencyMs: result.latency_ms ?? null,
      deviation: result.deviation || null,
      // 'system' | 'site' as before, with the counts it was decided on.
      crosscheck: crosscheck ? crosscheck.scope : null,
      crosscheckFailing: crosscheck ? crosscheck.failing : null,
      crosscheckTotal: crosscheck ? crosscheck.total : null,
      thresholds: thr,
    }],
    correlatedWith: [],
    createdAt: at,
    acked: false,
  };
}

// Evaluates the test's thresholds. Returns { metric, kind, severity } to alert,
// else null.
function evaluateThresholds({ test, result, recentStatuses = [], deviation }) {
  const thr = test && test.config ? test.config.thresholds : null;
  if (!thr) return null;

  if (Number.isInteger(thr.consecutive_fails) && thr.consecutive_fails > 0) {
    let streak = 0;
    for (const s of recentStatuses) { if (s !== 'ok') streak += 1; else break; }
    if (streak >= thr.consecutive_fails) return { metric: 'transaction.fail', kind: 'TRANSACTION_FAIL', severity: 'CRIT' };
  }
  if (Number.isInteger(thr.latency_ms) && thr.latency_ms > 0 && result.status === 'ok'
      && result.latency_ms != null && result.latency_ms > thr.latency_ms) {
    return { metric: 'transaction.latency', kind: 'TRANSACTION_LATENCY', severity: 'WARN' };
  }
  if (thr.deviation && deviation && (thr.deviation === 'any' || thr.deviation === deviation)) {
    return { metric: 'transaction.deviation', kind: 'TRANSACTION_DEVIATION', severity: 'WARN' };
  }
  return null;
}

module.exports = {
  PHASE_LABELS, stepsOf, classifyDeviation, diagnoseText, evaluateThresholds, buildTransactionFinding,
  MIN_BASELINE_SAMPLES, DEVIATION_K, TRANSACTION_REFIRE_MS,
};
