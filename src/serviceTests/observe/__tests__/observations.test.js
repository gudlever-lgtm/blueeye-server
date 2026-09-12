'use strict';

// The observation model (V3 Phase 1).
//
// Everything V3 reasons over reads these, so the assertions here are really
// about three promises the rest of the system depends on:
//
//   1. `unknown` never collapses into `ok`. "We did not look" and "we looked and
//      it was fine" are different answers, and the whole value of saying "the
//      network was healthy" is that somebody checked.
//   2. An observation states what was SEEN, never what it means. Conclusions
//      belong to the correlation engine.
//   3. Reading a run can never break.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { observationsFromRun, layerSummary, LAYERS, KIND } = require('../observations');

const RUN = {
  id: 9,
  test_id: 1,
  test_name: 'Customer Search',
  application_id: 2,
  environment_id: 3,
  journey_id: 4,
  status: 'fail',
  error_message: 'The server rejected the request',
  failure_kind: 'api',
  failed_step: 1,
  duration_ms: 1200,
  ended_at: new Date('2026-09-12T14:03:00Z'),
  steps: [
    { position: 0, label: 'Login', status: 'pass', duration_ms: 300 },
    { position: 1, label: 'Search Customer', status: 'fail', duration_ms: 900, message: 'No results appeared', step_type: 'assert_visible' },
  ],
  api_calls: [
    { method: 'POST', url: '/api/customer/search', status: 500, duration_ms: 120, resource_type: 'xhr' },
    { method: 'GET', url: '/api/auth/session', status: 200, duration_ms: 30, resource_type: 'xhr' },
  ],
  network_errors: [],
  console_errors: [],
};

const of = (obs, kind) => obs.filter((o) => o.kind === kind);

test('a run becomes typed facts, each carrying where it came from', () => {
  const obs = observationsFromRun(RUN);
  assert.ok(obs.length >= 6);
  // Every observation knows its scope, so correlation can ask questions across
  // runs without re-joining to find out what it was about.
  for (const o of obs) {
    assert.equal(o.run_id, 9);
    assert.equal(o.application_id, 2);
    assert.equal(o.journey_id, 4);
    assert.ok(LAYERS.includes(o.layer), o.layer);
  }
});

test('the run\'s own verdict is a fact, not just outer context', () => {
  // The correlation engine needs "the journey broke" alongside the technical
  // observations, not as something it has to be told separately.
  const [outcome] = of(observationsFromRun(RUN), KIND.RUN_OUTCOME);
  assert.equal(outcome.layer, 'browser');
  assert.equal(outcome.outcome, 'bad');
  assert.equal(outcome.subject, 'Customer Search');
  assert.equal(outcome.detail.failure_kind, 'api');
  // Observed when it happened, not when the row is written. A timeline built
  // from insert time would be a timeline of the database, not of the outage.
  assert.equal(outcome.observed_at.toISOString(), '2026-09-12T14:03:00.000Z');
});

test('a failing API call is an API fact; a request that never completed is a NETWORK one', () => {
  const obs = observationsFromRun({
    ...RUN,
    api_calls: [
      { method: 'POST', url: '/api/customer/search', status: 500, duration_ms: 120, resource_type: 'xhr' },
      { method: 'GET', url: '/api/slow', status: 0, duration_ms: 30000, resource_type: 'xhr' },
    ],
  });

  const api = of(obs, KIND.API_CALL);
  assert.equal(api.length, 1);
  assert.equal(api[0].layer, 'api');
  assert.equal(api[0].outcome, 'bad');
  assert.match(api[0].summary, /HTTP 500/);

  // Status 0 means the request never completed. Reading it as "the API answered
  // 0" would put a network fault on the API's record and send correlation the
  // wrong way.
  const network = of(obs, KIND.NETWORK_REQUEST);
  assert.equal(network.length, 1);
  assert.equal(network[0].layer, 'network');
  assert.match(network[0].summary, /did not complete/);
});

test('a healthy call is recorded as ok, not left out', () => {
  // "The auth API answered 200" is evidence. Keeping only failures is how a
  // correlation engine ends up unable to say what was working.
  const ok = observationsFromRun(RUN).find((o) => o.subject === '/api/auth/session');
  assert.equal(ok.outcome, 'ok');
  assert.equal(ok.value, 30);
  assert.equal(ok.unit, 'ms');
});

test('a duration is a measurement, never a verdict', () => {
  // 1200 ms is good or bad against a baseline, and that judgement belongs to
  // anomaly detection. Calling it here would be this module deciding something
  // it cannot know.
  const [duration] = of(observationsFromRun(RUN), KIND.DURATION);
  assert.equal(duration.outcome, 'unknown');
  assert.equal(duration.value, 1200);
  assert.equal(duration.unit, 'ms');
});

test('the failing STEP is its own fact', () => {
  // "Search failed" and "the run failed" are different statements, and impact
  // assessment needs the first one.
  const steps = of(observationsFromRun(RUN), KIND.STEP_OUTCOME);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].subject, 'Search Customer');
  assert.equal(steps[0].detail.position, 1);
});

test('assurance findings are observed but never counted as faults', () => {
  // A V2 rule that does not change here: an accessibility finding or a visual
  // difference is not the service being broken. Correlation should SEE them;
  // it must not weigh them as failures.
  const obs = observationsFromRun({
    ...RUN,
    accessibility: { counts: { serious: 2, moderate: 0, minor: 0, total: 2 } },
    visual: [{ step_index: 1, step_label: 'Search Customer', status: 'changed', changed_pct: 12, explanation: '12% different' }],
  });
  for (const o of obs.filter((x) => x.layer === 'assurance')) {
    assert.equal(o.outcome, 'unknown', `${o.kind} must not read as a fault`);
  }
  assert.equal(of(obs, KIND.ACCESSIBILITY)[0].value, 2);
  assert.equal(of(obs, KIND.VISUAL)[0].value, 12);
});

test('page script errors are a PAGE fact, not a service one', () => {
  // The service may be answering perfectly while the page's own JavaScript is
  // broken, and correlation can only say so if the layers are kept apart.
  const obs = observationsFromRun({ ...RUN, console_errors: ['TypeError: x is not a function'] });
  const [page] = of(obs, KIND.PAGE_CONSOLE);
  assert.equal(page.layer, 'page');
  assert.equal(page.outcome, 'bad');
  assert.equal(page.value, 1);
});

// --------------------------------------------------------------- layers
test('a layer nobody observed is UNKNOWN, never ok', () => {
  // The distinction the whole model exists for. Saying "network fine" because
  // nothing looked at the network is exactly the false reassurance V3 removes.
  const summary = layerSummary(observationsFromRun(RUN));
  assert.equal(summary.api.outcome, 'bad');
  assert.equal(summary.browser.outcome, 'bad');
  assert.equal(summary.network.outcome, 'unknown', 'nothing observed the network on this run');
  assert.equal(summary.server.outcome, 'unknown');
});

test('one bad observation makes a layer bad, however many good ones there are', () => {
  // A layer that answered correctly ninety-nine times and failed once is a layer
  // with a problem. Averaging it away is how an intermittent fault stays
  // invisible.
  const calls = [];
  for (let i = 0; i < 99; i += 1) calls.push({ method: 'GET', url: `/api/ok/${i}`, status: 200, duration_ms: 10 });
  calls.push({ method: 'GET', url: '/api/bad', status: 503, duration_ms: 10 });
  const summary = layerSummary(observationsFromRun({ ...RUN, api_calls: calls }));
  assert.equal(summary.api.outcome, 'bad');
  assert.equal(summary.api.ok, 99);
  assert.equal(summary.api.bad, 1);
});

test('a clean run says the layers it saw were ok', () => {
  const summary = layerSummary(observationsFromRun({
    ...RUN, status: 'pass', error_message: null, failure_kind: null, failed_step: null,
    steps: [{ position: 0, label: 'Login', status: 'pass', duration_ms: 300 }],
    api_calls: [{ method: 'GET', url: '/api/auth/session', status: 200, duration_ms: 30 }],
  }));
  assert.equal(summary.api.outcome, 'ok');
  assert.equal(summary.browser.outcome, 'ok');
});

test('a measurement nobody took never reads as a measurement of zero', () => {
  // The Number(null) trap, in the place it would do the most damage. A duration
  // of 0 ms is a service that answered instantly; a duration of null is a
  // service nobody timed. Anomaly detection and the health score both read
  // these, and confusing the two would report an unmeasured service as
  // infinitely fast.
  const obs = observationsFromRun({
    ...RUN,
    duration_ms: null,
    steps: [
      { position: 0, label: 'No timing', status: 'pass', duration_ms: null },
      { position: 1, label: 'Blank timing', status: 'pass', duration_ms: '   ' },
      { position: 2, label: 'Real timing', status: 'pass', duration_ms: 250 },
    ],
    api_calls: [{ method: 'GET', url: '/api/x', status: 200, duration_ms: '' }],
  });

  assert.equal(of(obs, KIND.DURATION).length, 0, 'a null run duration produces no measurement at all');
  const steps = of(obs, KIND.STEP_DURATION);
  assert.equal(steps.length, 1, 'null and whitespace timings are not measurements');
  assert.equal(steps[0].value, 250);
  // Number('') is 0 too — the same trap through a different door.
  assert.equal(obs.find((o) => o.subject === '/api/x').value, null);
});

// --------------------------------------------------------- never throws
test('junk in, no observations out — reading a run can never break', () => {
  for (const junk of [null, undefined, 'nope', 42, [], {}, { steps: 'no' }, { api_calls: [null, 7] },
    { status: 'fail', steps: [null], api_calls: [{}], network_errors: [null], console_errors: null }]) {
    assert.doesNotThrow(() => observationsFromRun(junk), JSON.stringify(junk));
  }
  assert.deepEqual(observationsFromRun(null), []);
  assert.deepEqual(layerSummary(null).api.outcome, 'unknown');
});

test('one broken extractor does not lose the other six', () => {
  // A run can contain anything, and the observation layer is the last place
  // that should be able to break reading a result.
  const hostile = {
    ...RUN,
    get api_calls() { throw new Error('bad column'); },
  };
  const obs = observationsFromRun(hostile);
  assert.ok(of(obs, KIND.RUN_OUTCOME).length, 'the verdict survived a broken extractor');
  assert.ok(of(obs, KIND.STEP_OUTCOME).length);
});
