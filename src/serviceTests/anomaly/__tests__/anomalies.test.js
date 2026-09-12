'use strict';

// Anomaly detection over rates.
//
// The specs are weighted towards what must NOT fire. A detector that cries wolf
// gets muted, and a muted detector is worse than none — it still costs the
// screen space and now nobody reads it. So: zero-failure baselines, tiny
// samples, statistically interesting but practically trivial moves, and runs
// that never reached a verdict all have a spec saying they stay quiet.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectAnomalies, compareRate, splitByTime, ruleOfThree,
  MIN_BASELINE_RUNS, MIN_RECENT_RUNS, K_SIGMA, MIN_RATE_DELTA,
} = require('../anomalies');

const NOW = new Date('2026-09-12T12:00:00.000Z');
const MIN = 60000;
const HOUR = 3600000;

// Runs laid out in time: `recent` inside the window, `old` outside it.
function history({ oldCount = 40, oldFails = 0, recentCount = 10, recentFails = 0,
  oldDuration = 900, recentDuration = 900, callsPerRun = 0, oldCallFails = 0, recentCallFails = 0 } = {}) {
  const runs = [];
  const calls = (fails, n) => Array.from({ length: n }, (_, i) => ({ status: i < fails ? 500 : 200 }));
  for (let i = 0; i < oldCount; i += 1) {
    runs.push({
      status: i < oldFails ? 'fail' : 'pass',
      duration_ms: oldDuration + (i % 5) * 10,
      ended_at: new Date(NOW.getTime() - 48 * HOUR - i * 10 * MIN),
      api_calls: calls(i < oldCallFails ? callsPerRun : 0, callsPerRun),
    });
  }
  for (let i = 0; i < recentCount; i += 1) {
    runs.push({
      status: i < recentFails ? 'fail' : 'pass',
      duration_ms: recentDuration,
      ended_at: new Date(NOW.getTime() - (recentCount - i) * MIN),
      api_calls: calls(i < recentCallFails ? callsPerRun : 0, callsPerRun),
    });
  }
  return runs;
}

const detect = (over = {}) => detectAnomalies({ runs: history(over), now: NOW, ...over.options });

// -------------------------------------------------------- it does not fire
test('a clean service with one bad run recently does not set off an alarm', () => {
  // The single most important spec here. Forty clean runs then one failure is a
  // failure, not a change in failure rate, and a detector that says otherwise
  // fires on every first failure a service ever has.
  const result = detect({ oldCount: 40, oldFails: 0, recentCount: 10, recentFails: 1 });
  assert.equal(result.failure_rate.verdict, 'normal', result.failure_rate.reason);
  assert.deepEqual(result.anomalies, []);
});

test('a baseline that never failed does not make the next failure infinitely anomalous', () => {
  // With a literal zero rate, expected is 0, the spread is 0, and any failure is
  // an infinite outlier. The rule of three is what stops that.
  assert.ok(ruleOfThree(40) > 0 && ruleOfThree(40) < 0.1);
  assert.equal(ruleOfThree(0), 1, 'no trials means nothing is ruled out');
  const result = compareRate({ trials: 100, events: 0 }, { trials: 10, events: 1 }, {});
  assert.equal(result.verdict, 'normal');
  assert.ok(Number.isFinite(result.sigma), 'the sigma went to infinity');
});

test('too little history says so rather than staying silent', () => {
  // "No anomaly" and "we could not tell" are different answers, and only one of
  // them means the service is fine.
  const result = detect({ oldCount: 5, recentCount: 6, recentFails: 4 });
  assert.equal(result.failure_rate.verdict, 'unknown');
  assert.equal(result.failure_rate.enough, false);
  assert.match(result.failure_rate.reason, /Not enough to compare/);
  assert.match(result.failure_rate.reason, new RegExp(`${MIN_BASELINE_RUNS} and ${MIN_RECENT_RUNS} are needed`));
});

test('a statistically interesting but trivial move does not become an alert', () => {
  // 1% to 4% over enough samples clears three sigma and is not worth waking
  // anybody for. The plain-percentage floor is what keeps it off the screen.
  const result = compareRate({ trials: 5000, events: 50 }, { trials: 500, events: 20 }, {});
  assert.ok(result.sigma >= K_SIGMA, 'this spec needs a case that IS statistically significant');
  assert.ok(result.delta < MIN_RATE_DELTA);
  assert.equal(result.verdict, 'normal');
});

test('a big move on too few samples does not become an alert either', () => {
  // Both bars have to be cleared, not either.
  const result = compareRate({ trials: 30, events: 6 }, { trials: 5, events: 2 }, {});
  assert.ok(result.delta >= MIN_RATE_DELTA, 'the move itself is large');
  assert.ok(result.sigma < K_SIGMA, 'but five runs cannot establish it');
  assert.equal(result.verdict, 'normal');
});

test('runs that never reached a verdict are not counted as trials', () => {
  // A queued or cancelled run is not a passing one, and counting it dilutes the
  // rate towards whatever the queue happened to be doing.
  const runs = history({ oldCount: 40, oldFails: 20, recentCount: 10, recentFails: 0 });
  for (let i = 0; i < 20; i += 1) {
    runs.push({ status: 'queued', ended_at: new Date(NOW.getTime() - 5 * MIN), api_calls: [] });
  }
  const result = detectAnomalies({ runs, now: NOW });
  assert.equal(result.failure_rate.recent_trials, 10, 'the queued runs were counted as trials');
});

// ------------------------------------------------------------ it does fire
test('a real jump in failure rate is reported, with the arithmetic behind it', () => {
  const result = detect({ oldCount: 40, oldFails: 0, recentCount: 10, recentFails: 6 });
  assert.equal(result.failure_rate.verdict, 'worse');
  assert.match(result.failure_rate.reason, /60% of the last 10 runs against 0%/);
  assert.match(result.failure_rate.reason, /where .* would be expected/);
  assert.ok(result.failure_rate.expected !== null, '"why did this fire" must always have an answer');
  assert.ok(result.anomalies.length);
});

test('a rate that FELL is reported too, and is not called good news', () => {
  // A test that stopped asserting looks exactly like a service that got fixed,
  // and only a person can tell which.
  const result = compareRate({ trials: 200, events: 100 }, { trials: 50, events: 2 }, {});
  assert.equal(result.verdict, 'better');
  assert.match(result.reason, /a test that stopped checking looks like this too/);
});

test('API errors are counted per call, not per run', () => {
  // A run making forty calls of which one fails and a run making one call that
  // fails are very different situations, and a per-run count cannot tell them
  // apart.
  const result = detect({
    oldCount: 40, callsPerRun: 5, oldCallFails: 0,
    recentCount: 20, recentCallFails: 16,
    options: {},
  });
  assert.equal(result.api_error_rate.baseline_trials, 200, 'the calls were counted, not the runs');
  assert.equal(result.api_error_rate.verdict, 'worse', result.api_error_rate.reason);
  assert.match(result.api_error_rate.reason, /API calls/);
});

test('a status 0 call counts as an error — a request that never completed is not a success', () => {
  const runs = history({ oldCount: 40, callsPerRun: 5 });
  for (let i = 0; i < 30; i += 1) {
    runs.push({
      status: 'pass', duration_ms: 900, ended_at: new Date(NOW.getTime() - (30 - i) * MIN),
      api_calls: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 200 }, { status: 200 }],
    });
  }
  const result = detectAnomalies({ runs, now: NOW });
  assert.equal(result.api_error_rate.verdict, 'worse', result.api_error_rate.reason);
});

// -------------------------------------------------------------- delegation
test('duration is judged by the baseline module, not by a second opinion here', () => {
  // Two modules with their own idea of "slower than normal" put two different
  // numbers on the same screen.
  const slow = detect({ oldCount: 40, oldDuration: 900, recentCount: 10, recentDuration: 9000 });
  assert.equal(slow.duration.verdict, 'slow');
  assert.match(slow.duration.reason, /normally/);
  assert.ok(slow.duration.baseline.enough);
  assert.ok(slow.anomalies.some((a) => a.metric === 'duration'));

  const steady = detect({ oldCount: 40, oldDuration: 900, recentCount: 10, recentDuration: 910 });
  assert.equal(steady.duration.verdict, 'normal');
});

test('a duration with too little history is unknown, not normal', () => {
  const result = detect({ oldCount: 2, recentCount: 6 });
  assert.equal(result.duration.verdict, 'unknown');
  assert.match(result.duration.reason, /not enough to say what normal is/);
});

// ------------------------------------------------------------- the window
test('the window is time, not a run count', () => {
  // "The last 10 runs" means something different on a test that runs every five
  // minutes than on one that runs nightly.
  const runs = history({ oldCount: 40, recentCount: 10 });
  const narrow = detectAnomalies({ runs, now: NOW, recentWindowMs: 5 * MIN });
  const wide = detectAnomalies({ runs, now: NOW, recentWindowMs: 24 * HOUR });
  assert.ok(narrow.window.recent_runs < wide.window.recent_runs);
  assert.equal(wide.window.recent_runs, 10);
});

test('an undated run joins the baseline, never the recent set', () => {
  // Mistaking old evidence for new produces a false alarm; the other way round
  // produces a quiet one, and quiet is the safer mistake.
  const { recent, baseline } = splitByTime([{ status: 'fail' }, { status: 'pass', ended_at: NOW }], NOW, HOUR);
  assert.equal(recent.length, 1);
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].status, 'fail');
});

test('nothing recent says so rather than reporting all clear', () => {
  const result = detectAnomalies({ runs: history({ oldCount: 40, recentCount: 0 }), now: NOW });
  assert.match(result.summary, /Nothing has run recently enough/);
  assert.deepEqual(result.anomalies, []);
});

test('a quiet result with a thin baseline admits the baseline is thin', () => {
  const result = detect({ oldCount: 8, recentCount: 6 });
  assert.match(result.summary, /only 8 earlier runs/);
});

// ------------------------------------------------------------- robustness
test('it never throws, whatever it is handed', () => {
  for (const input of [null, undefined, 'nope', 42, true, [], {},
    { runs: 'no' }, { runs: [null, 3, {}] }, { runs: history(), now: 'not a date' },
    { runs: history(), recentWindowMs: -5 }, { runs: history(), recentWindowMs: 'soon' }]) {
    assert.doesNotThrow(() => detectAnomalies(input), String(JSON.stringify(input)).slice(0, 60));
  }
  for (const input of [null, undefined, 'x', 42, []]) {
    assert.doesNotThrow(() => compareRate(input, input, {}));
  }
});

test('every threshold is published, so "why did this not fire" always has an answer', () => {
  const result = detect({ oldCount: 40, recentCount: 10, recentFails: 1 });
  const t = result.failure_rate.thresholds;
  assert.equal(t.min_baseline, MIN_BASELINE_RUNS);
  assert.equal(t.min_recent, MIN_RECENT_RUNS);
  assert.equal(t.k_sigma, K_SIGMA);
  assert.equal(t.min_delta, MIN_RATE_DELTA);
});

test('it says it is rules, so an AI second opinion can never be confused with it', () => {
  assert.equal(detect().source, 'rules');
});
