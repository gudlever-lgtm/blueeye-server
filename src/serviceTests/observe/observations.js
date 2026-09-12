'use strict';

// The observation model (V3 Phase 1, docs/service-assurance-v3.md).
//
// An OBSERVATION is one typed fact, with a layer and a source. Everything V3
// reasons over — correlation, root cause, incidents, health — reads these
// rather than re-parsing screenshots, error strings and prose. A run already
// KNOWS these facts; until now they were scattered across four columns in three
// shapes and had to be re-interpreted by every reader.
//
// PURE: a completed run in, observations out. No database, no clock beyond what
// the run already recorded — every judgement lives here where it can be argued
// with in a test.
//
// Three rules the rest of V3 depends on:
//
//   1. `unknown` is a real outcome. "We did not look" and "we looked and it was
//      fine" must never collapse into the same answer, because the whole value
//      of "the network was healthy" is that somebody checked.
//   2. An observation states what was SEEN, never what it means. "HTTP 500 from
//      /api/customer/search" is an observation; "the Customer API is broken" is
//      a conclusion, and conclusions belong to the correlation engine.
//   3. Nothing here can fail a run. It reads a finished result.

const { numOrNull } = require('../storage/shape');

const LAYERS = ['browser', 'page', 'api', 'application', 'server', 'network', 'infrastructure', 'assurance'];
const OUTCOMES = ['ok', 'bad', 'unknown'];

// The fact types this module produces. Open-ended in the database on purpose —
// detectors must be able to ship without a migration — but the set BlueEyes
// itself emits is named here so the gate can sweep it and so a reader has one
// place to learn what exists.
const KIND = {
  // browser / page
  RUN_OUTCOME: 'run.outcome',
  STEP_OUTCOME: 'step.outcome',
  PAGE_CONSOLE: 'page.console_errors',
  PAGE_LOAD: 'page.load',
  // api
  API_CALL: 'api.call',
  API_STATUS: 'api.status',
  // network / infrastructure
  NETWORK_REQUEST: 'network.request_failed',
  NETWORK_BLOCKED: 'network.blocked',
  DNS: 'network.dns',
  TLS: 'infrastructure.tls',
  // performance
  DURATION: 'performance.duration',
  STEP_DURATION: 'performance.step_duration',
  // assurance
  ACCESSIBILITY: 'assurance.accessibility',
  VISUAL: 'assurance.visual',
};

// A single observation, in one shape. Everything optional is explicitly null
// rather than absent: a reader that has to distinguish "missing" from
// "undefined" is a reader that will get it wrong once.
function observation({
  layer, kind, subject = null, outcome = 'unknown',
  value = null, unit = null, summary = null, detail = null, observedAt = null,
}) {
  return {
    layer: LAYERS.includes(layer) ? layer : 'application',
    kind,
    subject: subject === null || subject === undefined ? null : String(subject).slice(0, 512),
    outcome: OUTCOMES.includes(outcome) ? outcome : 'unknown',
    // numOrNull, not Number(): Number(null) and Number('   ') are both 0, and a
    // measurement nobody took must never read as a measurement of zero.
    value: numOrNull(value),
    unit: unit || null,
    summary: summary === null || summary === undefined ? null : String(summary).slice(0, 512),
    detail: detail || null,
    observed_at: observedAt instanceof Date ? observedAt : null,
  };
}

// A run's own verdict, as an observation. The correlation engine needs "the
// journey broke" as a fact alongside the technical ones, not as an outer
// context it has to be told about separately.
function fromOutcome(run) {
  const failed = run.status === 'fail' || run.status === 'error';
  return observation({
    layer: 'browser',
    kind: KIND.RUN_OUTCOME,
    subject: run.test_name || (run.test_id != null ? `test ${run.test_id}` : null),
    outcome: failed ? 'bad' : (run.status === 'pass' ? 'ok' : 'unknown'),
    summary: failed
      ? (run.error_message || 'The test failed')
      : (run.status === 'pass' ? 'The test passed' : `The run ended as ${run.status}`),
    detail: failed ? { failure_kind: run.failure_kind || null, failed_step: run.failed_step ?? null } : null,
    observedAt: run.ended_at || run.started_at || null,
  });
}

// Every API call the run saw. `api_calls` already carries method, status and
// duration with the URL masked at the boundary (V2 §5) — this types it so
// correlation can ask "did anything answer 5xx" without parsing prose.
function fromApiCalls(run) {
  const calls = Array.isArray(run.api_calls) ? run.api_calls : [];
  return calls.map((call) => {
    const status = Number(call.status);
    // Status 0 is "the request never completed" — a network-layer fact, not an
    // HTTP one, and correlation must not read it as "the API answered 0".
    const failed = status === 0 || (Number.isFinite(status) && status >= 400);
    const networkLevel = status === 0;
    return observation({
      layer: networkLevel ? 'network' : 'api',
      kind: networkLevel ? KIND.NETWORK_REQUEST : KIND.API_CALL,
      subject: call.url || null,
      outcome: failed ? 'bad' : 'ok',
      value: numOrNull(call.duration_ms),
      unit: 'ms',
      summary: networkLevel
        ? `${call.method || 'GET'} ${call.url || ''} did not complete`.trim()
        : `${call.method || 'GET'} ${call.url || ''} → HTTP ${status}`.trim(),
      detail: { method: call.method || null, status: Number.isFinite(status) ? status : null, resource_type: call.resource_type || null },
      observedAt: run.ended_at || null,
    });
  });
}

// Requests that never reached anything, and addresses the host policy refused.
// These are the network layer's evidence, and the reason "the network was fine"
// can be said with a straight face.
function fromNetworkErrors(run) {
  const errors = Array.isArray(run.network_errors) ? run.network_errors : [];
  return errors.map((e) => observation({
    layer: 'network',
    kind: e.error && /blocked|refused by policy/i.test(String(e.error)) ? KIND.NETWORK_BLOCKED : KIND.NETWORK_REQUEST,
    subject: e.url || null,
    outcome: 'bad',
    summary: e.error ? String(e.error) : `${e.url || 'a request'} failed`,
    detail: { status: e.status ?? null },
    observedAt: run.ended_at || null,
  }));
}

// Errors the PAGE reported about itself. A page layer fact: the service may be
// answering perfectly while its own JavaScript is broken.
function fromConsole(run) {
  const errors = Array.isArray(run.console_errors) ? run.console_errors : [];
  if (!errors.length) {
    // An empty list is only "the page was fine" when the errors were actually
    // COLLECTED, and V2 collects them on failure. On a passing run the column
    // is empty because nobody looked, which is a different fact — recording it
    // as ok would manufacture evidence that the page was checked.
    const collected = run.status === 'fail' || run.status === 'error';
    if (!collected) return [];
    return [observation({
      layer: 'page',
      kind: KIND.PAGE_CONSOLE,
      outcome: 'ok',
      value: 0,
      unit: 'errors',
      summary: 'The page reported no script errors',
      observedAt: run.ended_at || null,
    })];
  }
  return [observation({
    layer: 'page',
    kind: KIND.PAGE_CONSOLE,
    outcome: 'bad',
    value: errors.length,
    unit: 'errors',
    summary: `The page reported ${errors.length} script error${errors.length === 1 ? '' : 's'}`,
    detail: { errors: errors.slice(0, 20) },
    observedAt: run.ended_at || null,
  })];
}

// How long it took, per step and overall. Anomaly detection reads these, which
// is why the timings become observations rather than staying a column only the
// baseline code knows how to find.
function fromTimings(run) {
  const out = [];
  if (numOrNull(run.duration_ms) !== null) {
    out.push(observation({
      layer: 'browser',
      kind: KIND.DURATION,
      subject: run.test_name || null,
      // A duration is not good or bad on its own — it is good or bad against a
      // baseline, and that judgement belongs to anomaly detection, not here.
      outcome: 'unknown',
      value: Number(run.duration_ms),
      unit: 'ms',
      summary: `The run took ${Math.round(Number(run.duration_ms))} ms`,
      observedAt: run.ended_at || null,
    }));
  }
  for (const step of Array.isArray(run.steps) ? run.steps : []) {
    if (numOrNull(step.duration_ms) === null) continue;
    out.push(observation({
      layer: 'browser',
      kind: KIND.STEP_DURATION,
      subject: step.label || `step ${step.position}`,
      outcome: 'unknown',
      value: Number(step.duration_ms),
      unit: 'ms',
      detail: { position: step.position ?? null, status: step.status || null },
      observedAt: run.ended_at || null,
    }));
  }
  return out;
}

// Which step broke, as its own fact. "Search failed" and "the run failed" are
// different statements, and impact assessment needs the first one.
function fromSteps(run) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  return steps
    .filter((s) => s.status === 'fail')
    .map((s) => observation({
      layer: 'browser',
      kind: KIND.STEP_OUTCOME,
      subject: s.label || `step ${s.position}`,
      outcome: 'bad',
      summary: s.message || 'The step failed',
      detail: { position: s.position ?? null, step_type: s.step_type || null },
      observedAt: run.ended_at || null,
    }));
}

// V2's assurance checks, as observations. They never affect a verdict — that
// rule does not change here — but correlation should be able to SEE that the
// page also changed shape on the run where it broke.
function fromAssurance(run) {
  const out = [];
  const a11y = run.accessibility;
  if (a11y && a11y.counts) {
    out.push(observation({
      layer: 'assurance',
      kind: KIND.ACCESSIBILITY,
      outcome: 'unknown', // never 'bad': an accessibility finding is not a fault in the service
      value: a11y.counts.total || 0,
      unit: 'findings',
      summary: `${a11y.counts.total || 0} accessibility finding${(a11y.counts.total || 0) === 1 ? '' : 's'}`,
      detail: { counts: a11y.counts },
      observedAt: run.ended_at || null,
    }));
  }
  for (const visual of Array.isArray(run.visual) ? run.visual : []) {
    out.push(observation({
      layer: 'assurance',
      kind: KIND.VISUAL,
      subject: visual.step_label || `step ${visual.step_index}`,
      outcome: 'unknown', // a visual difference is reported, never a fault
      value: numOrNull(visual.changed_pct),
      unit: '%',
      summary: visual.explanation || null,
      detail: { status: visual.status || null },
      observedAt: run.ended_at || null,
    }));
  }
  return out;
}

// Everything a completed run observed.
//
//   observationsFromRun(run) -> [observation, ...]
//
// The run is read, never written. Called after a run completes, by the worker
// and by a backfill over existing runs — which is the whole reason it takes a
// stored run rather than live driver state.
function observationsFromRun(run) {
  if (!run || typeof run !== 'object') return [];
  const scope = {
    run_id: run.id ?? null,
    test_id: run.test_id ?? null,
    journey_id: run.journey_id ?? null,
    application_id: run.application_id ?? null,
    environment_id: run.environment_id ?? null,
  };
  const parts = [
    fromOutcome, fromSteps, fromApiCalls, fromNetworkErrors,
    fromConsole, fromTimings, fromAssurance,
  ];
  const out = [];
  for (const part of parts) {
    // One extractor throwing must not lose the other six. A run can contain
    // anything, and the observation layer is the last place that should be able
    // to break reading a result.
    let produced = [];
    try { produced = part(run) || []; } catch { produced = []; }
    for (const o of [].concat(produced)) out.push({ ...scope, ...o });
  }
  return out;
}

// A compact summary of what a set of observations says per layer.
//
// This is what makes "Network ✓ · Server ✓ · API ✗" possible, and it is
// deliberately here rather than in the correlation engine: it states what was
// seen, not what it means.
//
// A layer nobody observed is `unknown`, NOT ok. That distinction is the whole
// reason this is not a boolean — reporting "network fine" because nothing
// looked at the network is exactly the false reassurance V3 exists to remove.
function layerSummary(observations) {
  const out = {};
  for (const layer of LAYERS) out[layer] = { outcome: 'unknown', ok: 0, bad: 0 };
  for (const o of Array.isArray(observations) ? observations : []) {
    const bucket = out[o.layer];
    if (!bucket) continue;
    if (o.outcome === 'ok') bucket.ok += 1;
    else if (o.outcome === 'bad') bucket.bad += 1;
  }
  for (const layer of LAYERS) {
    const bucket = out[layer];
    // One bad observation makes a layer bad. A layer that answered correctly
    // ninety-nine times and failed once is a layer with a problem, and averaging
    // it away is how an intermittent fault stays invisible.
    if (bucket.bad > 0) bucket.outcome = 'bad';
    else if (bucket.ok > 0) bucket.outcome = 'ok';
  }
  return out;
}

module.exports = {
  observationsFromRun, layerSummary, observation,
  LAYERS, OUTCOMES, KIND,
};
