'use strict';

const { numOrNull } = require('../storage/shape');
const { describeTarget } = require('../engine/targeting');
const { fmt } = require('./baseline');

// Evidence (V2 §10, P2 #9) — "gem evidensen".
//
// The spec asks for the observations a run made, kept so they can be used later
// for analysis and correlation: URL, HTTP method, HTTP status, timings, failed
// requests, selector information, page information, error messages, screenshots.
//
// NOTHING NEW IS STORED. Every one of those is already recorded — api_calls
// (migration 081), console_errors, network_errors, the step rows with their
// targets and messages, screenshot_path. What was missing was a single place
// that gathers them into one shape and says what each one is, so "here is what
// we saw" is one request rather than four screens and some SQL.
//
// The rule that shapes the whole file is the spec's other sentence: *ingen
// passwords, tokens, cookies eller authorization headers*. The runner already
// masks on the way IN — a secret that never enters a column cannot leave it —
// and this assembles only from those already-masked columns. It adds no new
// source of data, which is the strongest guarantee available: there is nothing
// here to forget to scrub.
//
// PURE: a run (with its steps) in, an evidence record out.

// Request kinds worth keeping as evidence. Images, fonts and stylesheets are a
// hundred rows per page load and none of them says whether the service works.
const INTERESTING = new Set(['xhr', 'fetch', 'document', 'script', undefined, null, '']);

const bad = (call) => {
  const status = numOrNull(call && call.status);
  // Status 0 means the request never completed — a DNS failure, a refused
  // connection, a blocked host. It is the most informative value in the set and
  // reads as "fine" to anything comparing with >= 400.
  return status === 0 || (status !== null && status >= 400);
};

// The evidence one run produced.
//
//   { run, page, steps, api, failures, timings, screenshot }
//
// Every section is what was OBSERVED. Nothing here concludes anything — the
// likely cause belongs to the run's classification, and keeping the two apart
// is the spec's rule that observed and probable must never be presented as the
// same kind of fact.
function evidenceFor(run, { baseline = null, lang = 'en' } = {}) {
  if (!run || typeof run !== 'object') return null;
  // Filtered, not trusted. These arrive from JSON columns and from a worker
  // process; a null in the list must not turn "show me what happened" into a
  // 500 on the one screen an operator opens when something is already wrong.
  const steps = (Array.isArray(run.steps) ? run.steps : []).filter((s) => s && typeof s === 'object');
  const calls = (Array.isArray(run.api_calls) ? run.api_calls : [])
    .filter((c) => c && typeof c === 'object' && INTERESTING.has(c.resource_type));

  const failedCalls = calls.filter(bad);
  const slowest = calls
    .filter((c) => numOrNull(c.duration_ms) !== null)
    .sort((a, b) => numOrNull(b.duration_ms) - numOrNull(a.duration_ms))
    .slice(0, 5);

  const failedStep = steps.find((s) => s.status === 'fail') || null;

  return {
    run: {
      id: run.id,
      test_id: run.test_id,
      status: run.status,
      started_at: run.started_at,
      ended_at: run.ended_at,
      duration_ms: numOrNull(run.duration_ms),
      browser: run.browser || null,
      trigger_source: run.trigger_source || null,
      test_version: run.test_version ?? null,
    },

    // Where the browser was when it stopped, and what the page said.
    page: {
      url: pageUrlOf(run, failedStep),
      failure_kind: run.failure_kind || null,
      error_message: run.error_message || null,
      console_errors: (run.console_errors || []).slice(0, 20),
      network_errors: (run.network_errors || []).slice(0, 20),
    },

    // What the test was pointing at, in words AND as the hint bag — the bag is
    // what a later analysis can compare; the words are what a person reads.
    steps: steps.map((s) => ({
      position: s.position,
      path: s.path ?? null,
      step_type: s.step_type,
      label: s.label,
      status: s.status,
      duration_ms: numOrNull(s.duration_ms),
      message: s.message || null,
      target: targetOf(s),
      target_label: targetOf(s) ? describeTarget(targetOf(s), { lang }) : null,
    })),

    // Every call the page made, with the method, the masked URL, the status and
    // how long it took.
    api: {
      total: calls.length,
      failed: failedCalls.length,
      calls: calls.slice(0, 100).map(shapeCall),
      slowest: slowest.map(shapeCall),
    },

    // The subset an operator looks at first.
    failures: {
      step: failedStep ? {
        position: failedStep.position,
        label: failedStep.label,
        message: failedStep.message || null,
        target_label: targetOf(failedStep) ? describeTarget(targetOf(failedStep), { lang }) : null,
      } : null,
      api: failedCalls.slice(0, 20).map(shapeCall),
    },

    // Performance as metadata on the result, which is all §9 asks for.
    timings: {
      total_ms: numOrNull(run.duration_ms),
      total_label: fmt(run.duration_ms, lang),
      slowest_step: slowestStep(steps),
      // Null unless there is enough history. "unknown" is a real answer and
      // must not be dressed up as "normal".
      baseline: baseline || null,
    },

    screenshot: run.screenshot_path ? { available: true, run_id: run.id } : { available: false },
  };
}

function shapeCall(call) {
  return {
    method: call.method || null,
    url: call.url || null,
    status: numOrNull(call.status),
    duration_ms: numOrNull(call.duration_ms),
    resource_type: call.resource_type || null,
    // The runner's own verdict on this call, kept as it was recorded.
    verdict: call.verdict || null,
  };
}

// A step's target, wherever the runner put it. Steps carry it in `detail` when
// the step failed and on the step itself otherwise, and a reader should not have
// to know which.
function targetOf(step) {
  if (!step || typeof step !== 'object') return null;
  if (step.target && typeof step.target === 'object') return step.target;
  if (step.detail && step.detail.target && typeof step.detail.target === 'object') return step.detail.target;
  return null;
}

function pageUrlOf(run, failedStep) {
  if (failedStep && failedStep.detail && failedStep.detail.url) return failedStep.detail.url;
  const withUrl = (Array.isArray(run.steps) ? run.steps : [])
    .filter((s) => s && typeof s === 'object' && s.detail && s.detail.url);
  return withUrl.length ? withUrl[withUrl.length - 1].detail.url : null;
}

function slowestStep(steps) {
  const timed = (Array.isArray(steps) ? steps : [])
    .filter((s) => s && typeof s === 'object' && numOrNull(s.duration_ms) !== null);
  if (!timed.length) return null;
  const worst = timed.reduce((a, b) => (numOrNull(b.duration_ms) > numOrNull(a.duration_ms) ? b : a));
  return {
    position: worst.position,
    label: worst.label,
    duration_ms: numOrNull(worst.duration_ms),
  };
}

// The secrets that must never appear in evidence, as a checkable list rather
// than a comment. The specs use it to assert the whole assembled record, which
// is how "we mask on the way in" stays true rather than becoming folklore.
const FORBIDDEN_KEYS = ['password', 'passwd', 'token', 'cookie', 'authorization', 'auth', 'secret', 'set-cookie'];

module.exports = { evidenceFor, shapeCall, targetOf, slowestStep, FORBIDDEN_KEYS, INTERESTING };
