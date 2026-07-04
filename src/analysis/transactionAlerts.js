'use strict';

// Pure helpers for transaction alerting: phase → Danish diagnosis, baseline
// deviation classification, and threshold evaluation. All I/O (baseline lookups,
// cross-check, Mistral) lives in the caller (src/ws/agentSocket.js); everything
// here is pure and unit-testable.

// Failure-phase → human-readable Danish diagnosis. Mirrored in the dashboard
// (public/app.js) so alert text and UI diagnosis read identically.
const PHASE_LABELS = {
  dns: 'DNS-opslag mislykkedes — hostnavnet kunne ikke løses',
  connect: 'TCP-forbindelsen fejlede — netværk, firewall eller host nede',
  tls: 'TLS-håndtrykket fejlede — certifikat- eller protokolproblem',
  http_status: 'Uventet HTTP-statuskode',
  keyword: 'Svaret manglede det forventede indhold',
  timeout: 'Trinnet timede ud',
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

// Danish template diagnosis — the Mistral fallback. Uses the agent's structured
// detail.phase, the deviation, and the cross-check scope.
function diagnoseText({ test, agentId, result, deviation, deviationStep, crosscheck }) {
  const detail = result && result.detail && typeof result.detail === 'object' ? result.detail : {};
  const stepIdx = detail.step != null ? detail.step : deviationStep;
  const stepPart = stepIdx != null ? ` (trin ${stepIdx})` : '';
  let head;
  if (result.status === 'ok') {
    head = deviation ? `Latenstid væsentligt ${deviation === 'slower' ? 'over' : 'under'} baseline` : 'OK';
  } else {
    head = PHASE_LABELS[detail.phase] || `Fejlede (${result.status})`;
    if (detail.errno) head += ` [${detail.errno}]`;
  }
  let scope = '';
  if (crosscheck) {
    scope = crosscheck.scope === 'system'
      ? ' — alle tildelte agenter fejler: systemet er nede'
      : ` — kun agent ${agentId} fejler: problem fra denne agents site/netværk`;
  }
  return `Transaktionstest "${test.name}"${stepPart}: ${head}${scope}`;
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
  PHASE_LABELS, stepsOf, classifyDeviation, diagnoseText, evaluateThresholds,
  MIN_BASELINE_SAMPLES, DEVIATION_K,
};
