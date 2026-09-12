'use strict';

const { numOrNull } = require('../storage/shape');
const { baselineFrom, compare } = require('../analysis/baseline');

// Anomaly detection (V3 Phase 2, docs/service-assurance-v3.md §"Anomaly
// detection"): response time, failure rate, API errors, journey duration.
//
// Response time and journey duration were already done properly — median + MAD
// in `analysis/baseline.js`. This does NOT re-implement them; it calls them. Two
// modules with their own opinion of what "slower than normal" means is worse
// than either being wrong, because the dashboard would show both.
//
// What is new here is RATES, and they need a different tool. Median and MAD
// over a proportion is nonsense at the sample sizes a synthetic monitor
// produces: twenty runs with two failures has a median failure rate of zero and
// a MAD of zero, so the band is 0–0 and the twenty-first failure is a
// catastrophic outlier. Every run would be an anomaly.
//
// So a rate is judged the way a rate should be: against how many failures the
// baseline rate would have PRODUCED over the recent runs, and how far the
// observed count sits from that in the binomial spread. No library, no p-value,
// no pretence — one line of arithmetic anybody can check.
//
// PURE: runs in, findings out. No database, no clock beyond the `now` handed in.
//
// Three rules:
//
//   1. A rate needs more history than a median does. Five runs cannot tell you
//      a failure rate changed; they can barely tell you it exists. Every
//      threshold is named in the output, so "why did this not fire" always has
//      an answer.
//   2. A CHANGE IS NOT A PROBLEM. A failure rate that fell is reported the same
//      way a run that got faster is: as something to look at, because a test
//      that stopped asserting looks exactly like a service that got fixed.
//   3. Nothing here fails anything. An anomaly is a WARNING on a result, like
//      every other performance signal in this codebase — a detector that can
//      fail a test is one people delete the test to get rid of.

// A rate needs this much history behind it. Twenty is not statistics, but it is
// the point below which the arithmetic stops meaning anything at all.
const MIN_BASELINE_RUNS = 20;

// And this much recent evidence. Below it, one bad run IS the window.
const MIN_RECENT_RUNS = 5;

// How far past the expected count, in binomial standard deviations, before it
// is called a change. Three is deliberately wide, for the same reason the
// duration band is: a synthetic journey drives a real browser over a real
// network, and a detector that fires on ordinary variance trains people to
// ignore it.
const K_SIGMA = 3;

// And a floor in plain percentage points, so a statistically interesting move
// from 1% to 4% does not become an alert nobody would act on.
const MIN_RATE_DELTA = 0.15;

// The window that counts as "recent", when the caller does not say.
const DEFAULT_RECENT_MS = 6 * 3600000;

// When the baseline saw ZERO failures, its true rate is not zero — it is
// somewhere below roughly 3/n (the rule of three: the 95% upper bound on an
// event that did not happen in n trials). Using a literal zero would make the
// expected count zero, the spread zero, and the very next failure an infinite
// outlier — which is how a clean service produces an alert storm the first time
// anything goes wrong.
const ruleOfThree = (trials) => (trials > 0 ? 3 / trials : 1);

const asDate = (v) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const FAILED = new Set(['fail', 'error']);
const COUNTED = new Set(['fail', 'error', 'pass']);

// Is this rate different from that one, and is the difference worth telling
// somebody about?
//
// `baseline` and `recent` are each { trials, events }. Returns a finding, or one
// that says plainly it did not have enough to judge — never silence, because
// "no anomaly" and "we could not tell" are different answers and the screen has
// to be able to show which.
function compareRate(rawBaseline, rawRecent, { label = 'rate', unit = 'runs', minBaseline = MIN_BASELINE_RUNS, minRecent = MIN_RECENT_RUNS } = {}) {
  const base = rawBaseline && typeof rawBaseline === 'object' ? rawBaseline : {};
  const now = rawRecent && typeof rawRecent === 'object' ? rawRecent : {};
  const baseTrials = Math.max(0, numOrNull(base.trials) || 0);
  const baseEvents = Math.max(0, numOrNull(base.events) || 0);
  const recentTrials = Math.max(0, numOrNull(now.trials) || 0);
  const recentEvents = Math.max(0, numOrNull(now.events) || 0);

  const thresholds = {
    min_baseline: minBaseline, min_recent: minRecent, k_sigma: K_SIGMA, min_delta: MIN_RATE_DELTA,
  };

  if (baseTrials < minBaseline || recentTrials < minRecent) {
    return {
      metric: label,
      verdict: 'unknown',
      enough: false,
      baseline_rate: baseTrials > 0 ? baseEvents / baseTrials : null,
      recent_rate: recentTrials > 0 ? recentEvents / recentTrials : null,
      baseline_trials: baseTrials,
      recent_trials: recentTrials,
      expected: null,
      observed: recentEvents,
      sigma: null,
      thresholds,
      reason: `Not enough to compare: ${baseTrials} earlier ${unit} and ${recentTrials} recent `
        + `(${minBaseline} and ${minRecent} are needed).`,
    };
  }

  const observedRate = baseEvents / baseTrials;
  // Never literally zero — see ruleOfThree.
  const rate = Math.max(observedRate, ruleOfThree(baseTrials));
  const recentRate = recentEvents / recentTrials;
  const expected = rate * recentTrials;
  // The binomial spread of that expected count. sqrt(n·p·(1−p)).
  const sigma = Math.sqrt(Math.max(0, recentTrials * rate * (1 - rate)));
  const delta = recentRate - observedRate;
  // A sigma of zero would divide by nothing. It cannot happen once `rate` is
  // floored above zero and recentTrials is at least the minimum, but the guard
  // costs nothing and an Infinity on a dashboard costs a page.
  const away = sigma > 0 ? (recentEvents - expected) / sigma : 0;

  const base_fields = {
    metric: label,
    enough: true,
    baseline_rate: observedRate,
    recent_rate: recentRate,
    baseline_trials: baseTrials,
    recent_trials: recentTrials,
    expected: Math.round(expected * 100) / 100,
    observed: recentEvents,
    sigma: Math.round(away * 100) / 100,
    delta: Math.round(delta * 1000) / 1000,
    thresholds,
  };

  const pct = (n) => `${Math.round(n * 100)}%`;

  // Rule 1 and the plain-percentage floor together: statistically interesting
  // and worth acting on are different bars, and this has to clear both.
  if (away >= K_SIGMA && delta >= MIN_RATE_DELTA) {
    return {
      ...base_fields,
      verdict: 'worse',
      reason: `${pct(recentRate)} of the last ${recentTrials} ${unit} against ${pct(observedRate)} `
        + `over the previous ${baseTrials} — ${recentEvents} where ${base_fields.expected} would be expected.`,
    };
  }
  // Rule 2. Reported, not celebrated: a test that stopped asserting looks
  // exactly like a service that got fixed, and only a person can tell which.
  if (-away >= K_SIGMA && -delta >= MIN_RATE_DELTA) {
    return {
      ...base_fields,
      verdict: 'better',
      reason: `${pct(recentRate)} of the last ${recentTrials} ${unit} against ${pct(observedRate)} `
        + `over the previous ${baseTrials}. Worth a look: a test that stopped checking looks like this too.`,
    };
  }
  return {
    ...base_fields,
    verdict: 'normal',
    reason: `${pct(recentRate)} of the last ${recentTrials} ${unit}, against ${pct(observedRate)} normally.`,
  };
}

// Split a run history into what is recent and what is the baseline.
//
// By TIME, not by count. "The last 10 runs" is a different window on a test that
// runs every five minutes than on one that runs nightly, and a detector whose
// window silently changes meaning per test is one nobody can reason about.
function splitByTime(rawRuns, rawNow, rawRecentMs) {
  // Exported, so it is called by things this file does not control — and
  // `now.getTime()` on a string is one of the throws the never-throw sweep
  // exists to catch. It caught this one.
  const list = (Array.isArray(rawRuns) ? rawRuns : []).filter((r) => r && typeof r === 'object');
  const now = asDate(rawNow) || new Date();
  const recentMs = Math.max(60000, numOrNull(rawRecentMs) || DEFAULT_RECENT_MS);
  const cutoff = new Date(now.getTime() - recentMs);
  const recent = [];
  const baseline = [];
  for (const run of list) {
    const at = asDate(run.ended_at || run.started_at || run.created_at);
    // A run with no timestamp cannot be placed in a window. It joins the
    // baseline rather than the recent set: mistaking old evidence for new is
    // what produces a false alarm, and the other way round produces a quiet one.
    if (!at || at <= cutoff) baseline.push(run);
    else recent.push(run);
  }
  return { recent, baseline };
}

// Everything worth saying about one test's recent behaviour.
function detectAnomalies(rawInput = {}) {
  // A default parameter covers `undefined` and nothing else.
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const runs = (Array.isArray(input.runs) ? input.runs : []).filter((r) => r && typeof r === 'object');
  const now = asDate(input.now) || new Date();
  const recentMs = Math.max(60000, numOrNull(input.recentWindowMs) || DEFAULT_RECENT_MS);
  const lang = input.lang === 'da' ? 'da' : 'en';

  const { recent, baseline } = splitByTime(runs, now, recentMs);

  // --- failure rate ---------------------------------------------------------
  // Only runs that reached a verdict. A queued or cancelled run is not a
  // passing one, and counting it as a trial dilutes the rate towards whatever
  // the queue happened to be doing.
  const verdicts = (list) => list.filter((r) => COUNTED.has(r.status));
  const failureRate = compareRate(
    { trials: verdicts(baseline).length, events: verdicts(baseline).filter((r) => FAILED.has(r.status)).length },
    { trials: verdicts(recent).length, events: verdicts(recent).filter((r) => FAILED.has(r.status)).length },
    { label: 'failure_rate', unit: 'runs' }
  );

  // --- API errors -----------------------------------------------------------
  // Counted per CALL, not per run: a run making forty calls of which one fails
  // and a run making one call that fails are very different, and a per-run count
  // cannot tell them apart. Status 0 counts — a request that never completed is
  // not a successful one.
  const calls = (list) => {
    let trials = 0;
    let events = 0;
    for (const run of list) {
      for (const call of (Array.isArray(run.api_calls) ? run.api_calls : [])) {
        const status = numOrNull(call && call.status);
        if (status === null) continue;
        trials += 1;
        if (status === 0 || status >= 400) events += 1;
      }
    }
    return { trials, events };
  };
  const apiErrors = compareRate(calls(baseline), calls(recent), {
    label: 'api_error_rate', unit: 'API calls',
    // A run makes several calls, so the same wall-clock history yields many more
    // samples here — the minimums scale with it rather than being reused.
    minBaseline: MIN_BASELINE_RUNS * 5, minRecent: MIN_RECENT_RUNS * 2,
  });

  // --- duration -------------------------------------------------------------
  // Delegated, not re-derived. `analysis/baseline.js` is where median + MAD
  // lives and where "slower than normal" is defined; a second opinion here
  // would put two different numbers on the same screen.
  const passed = (list) => list.filter((r) => r.status === 'pass');
  const durationBase = baselineFrom(passed(baseline).map((r) => r.duration_ms));
  const latest = recent.length ? recent[recent.length - 1] : null;
  const duration = latest
    ? { metric: 'duration', ...compare(latest.duration_ms, durationBase, { lang }) }
    : { metric: 'duration', verdict: 'unknown', duration_ms: null, baseline: durationBase, ratio: null,
      reason: 'No run in the recent window to compare.' };

  const findings = [failureRate, apiErrors, duration];
  // Rule 3: these are WARNINGS. Nothing here is a verdict on a run, and the
  // word "anomalous" is reserved for the two directions that are real changes.
  const anomalies = findings.filter((f) => f.verdict === 'worse' || f.verdict === 'better'
    || f.verdict === 'slow' || f.verdict === 'fast');

  return {
    findings,
    anomalies,
    failure_rate: failureRate,
    api_error_rate: apiErrors,
    duration,
    window: { recent_ms: recentMs, recent_runs: recent.length, baseline_runs: baseline.length, now },
    summary: summarise(anomalies, recent.length, baseline.length),
    source: 'rules',
  };
}

function summarise(anomalies, recentRuns, baselineRuns) {
  if (!recentRuns) return 'Nothing has run recently enough to compare.';
  if (!anomalies.length) {
    return baselineRuns < MIN_BASELINE_RUNS
      ? `Nothing stands out, but there are only ${baselineRuns} earlier runs to compare with.`
      : 'Nothing stands out against this test’s own history.';
  }
  return anomalies.map((a) => a.reason).join(' ');
}

module.exports = {
  detectAnomalies, compareRate, splitByTime, ruleOfThree,
  MIN_BASELINE_RUNS, MIN_RECENT_RUNS, K_SIGMA, MIN_RATE_DELTA, DEFAULT_RECENT_MS,
};
