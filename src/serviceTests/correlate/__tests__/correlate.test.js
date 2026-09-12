'use strict';

// The correlation engine (V3 Phase 1).
//
// Most of these assertions are about ONE property: confidence must come from
// what was ruled out. "It is the API, 92% confident" is only honest if something
// actually established that the network and the server were fine. If nothing
// did, the API is merely the layer we happened to look at, and a high number
// would be inventing certainty out of ignorance.
//
// The rest are about the three rules: a conclusion is an assessment and never a
// fact, nothing is concluded from nothing, and confidence never reaches 100.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { observationsFromRun } = require('../../observe/observations');
const { correlate, describeCorrelation, primaryFailure, CONFIDENCE } = require('../correlate');

const run = (over = {}) => observationsFromRun({
  id: 1, test_id: 1, application_id: 1,
  status: 'fail',
  steps: [{ position: 1, label: 'Customer Search', status: 'fail', duration_ms: 900, message: 'No results appeared' }],
  api_calls: [],
  network_errors: [],
  console_errors: [],
  duration_ms: 1200,
  ended_at: new Date('2026-09-12T14:03:00Z'),
  ...over,
});

const API_500 = { method: 'POST', url: '/api/customer/search', status: 500, duration_ms: 120 };
const API_OK = { method: 'GET', url: '/api/auth/session', status: 200, duration_ms: 30 };

// ------------------------------------------------------ nothing from nothing
test('a passing run produces no correlation at all', () => {
  // A correlation that reports "everything is fine" is noise. Silence is the
  // honest answer when nothing failed.
  const passing = observationsFromRun({
    id: 1, test_id: 1, application_id: 1, status: 'pass',
    steps: [{ position: 0, label: 'Login', status: 'pass', duration_ms: 200 }],
    api_calls: [API_OK], duration_ms: 400, ended_at: new Date(),
  });
  assert.equal(correlate({ observations: passing }), null);
  assert.equal(correlate({ observations: [] }), null);
  assert.equal(correlate({}), null);
});

// ----------------------------------------------------- the spec's example
test('the worked example from the spec, end to end', () => {
  const result = correlate({
    observations: run({ api_calls: [API_500, API_OK] }),
    history: { sameFailureCount: 6 },
  });

  assert.equal(result.layer, 'api');
  assert.match(result.conclusion, /application or API/);
  // The chain reads the way a person reasons: the symptom, the technical cause,
  // then what was ruled out.
  const steps = result.chain.map((c) => c.step);
  assert.match(steps[0], /No results appeared/);
  assert.match(steps[1], /HTTP 500/);
  assert.ok(steps.some((s) => /network reachable/.test(s)));
  assert.ok(steps.some((s) => /6 times/.test(s)));
  // And the evidence is attached, so the conclusion can be checked rather than
  // trusted.
  assert.ok(result.evidence.length);
  assert.equal(result.source, 'rules');
});

// ------------------------------------------------------------- confidence
test('confidence comes from what was RULED OUT, not from what failed', () => {
  // The property the whole module is built around. Same failure, same layer —
  // the only difference is how much was established about everything else.
  const blind = correlate({
    observations: run({ api_calls: [API_500] }),
  });
  const informed = correlate({
    observations: run({ api_calls: [API_500, API_OK] }),
    history: { sameFailureCount: 6 },
  });

  assert.equal(blind.layer, 'api');
  assert.equal(informed.layer, 'api');
  assert.ok(informed.confidence > blind.confidence + 20,
    `ruling things out must raise confidence materially (${blind.confidence} → ${informed.confidence})`);
});

test('every layer nobody looked at is named, and lowers confidence', () => {
  const result = correlate({ observations: run({ api_calls: [API_500] }) });
  assert.ok(result.not_checked.length, 'the holes in the picture must be listed');
  const penalty = result.confidence_from.find((c) => c.points < 0);
  assert.ok(penalty, 'not checking something must cost confidence');
  assert.match(penalty.reason, /not checked/);
  // And it is said on screen, not buried in a field.
  assert.match(describeCorrelation(result), /not checked/);
});

test('confidence never reaches certainty, and never bottoms out at zero', () => {
  // A rule-based inference over a sample is not a fact, and a number that says
  // it is would be the one thing on screen nobody should trust.
  const best = correlate({
    observations: run({
      api_calls: [API_500, API_OK, { method: 'GET', url: '/api/x', status: 200, duration_ms: 10 }],
      console_errors: [],
    }),
    history: { sameFailureCount: 50 },
  });
  assert.ok(best.confidence <= CONFIDENCE.CEILING, `${best.confidence} exceeded the ceiling`);
  assert.ok(best.confidence >= CONFIDENCE.FLOOR);
});

test('the arithmetic is itemised — "why 85%?" always has an answer', () => {
  const result = correlate({
    observations: run({ api_calls: [API_500, API_OK] }),
    history: { sameFailureCount: 6 },
  });
  assert.ok(result.confidence_from.length >= 3);
  for (const line of result.confidence_from) {
    assert.equal(typeof line.reason, 'string');
    assert.equal(typeof line.points, 'number');
    assert.ok(line.reason.length > 5, 'a contribution must say something');
  }
});

// -------------------------------------------------- observed vs inferred
test('an inferred clearance is never reported as a probe', () => {
  // "The network was checked" and "the network must be working because
  // something answered" are different claims, and only the second is true when
  // a browser test is all that ran.
  const result = correlate({ observations: run({ api_calls: [API_500, API_OK] }) });

  const chainText = result.chain.map((c) => c.step).join(' | ');
  assert.match(chainText, /network reachable — .*answered/);
  assert.ok(!/network was checked/.test(chainText));

  const ruled = result.confidence_from.find((c) => /must be working/.test(c.reason));
  assert.ok(ruled, 'the inference must be labelled as one in the arithmetic too');
});

test('a request that never completed makes it the NETWORK, not the API', () => {
  // Status 0 means nothing answered. Concluding "API problem" from it would
  // send somebody to read application logs for a cable fault.
  const result = correlate({
    observations: run({ api_calls: [{ method: 'GET', url: '/api/x', status: 0, duration_ms: 30000 }] }),
  });
  assert.equal(result.layer, 'network');
  assert.match(result.conclusion, /network/);
});

// ----------------------------------------------------------- ambiguity
test('two failing layers lower confidence rather than picking one confidently', () => {
  const single = correlate({ observations: run({ api_calls: [API_500, API_OK] }) });
  const ambiguous = correlate({
    observations: run({
      api_calls: [API_500, API_OK],
      console_errors: ['TypeError: undefined is not a function'],
    }),
  });
  assert.ok(ambiguous.confidence < single.confidence,
    `an ambiguous picture must be less confident (${single.confidence} → ${ambiguous.confidence})`);
  assert.ok(ambiguous.confidence_from.some((c) => /ambiguous/.test(c.reason)));
});

// --------------------------------------------------- nothing underneath
test('a journey that broke with nothing underneath it says exactly that', () => {
  // Common and real: a missing element, a changed page, a test that needs
  // updating. Inventing a technical cause would be worse than saying so.
  const result = correlate({ observations: run({ api_calls: [API_OK] }) });
  assert.equal(result.layer, null);
  assert.match(result.conclusion, /nothing underneath it reported a problem/);
  // And no confidence number, because there is no conclusion to be confident
  // about.
  assert.equal(result.confidence, null);
});

test('the browser failing is the symptom and is never the conclusion', () => {
  // The test failed, therefore the browser is at fault, therefore the test
  // failed. Concluding that would be circular.
  const result = correlate({ observations: run({ api_calls: [API_500] }) });
  assert.notEqual(result.layer, 'browser');
  assert.ok(result.failed.includes('browser'), 'the browser failure is still recorded as a fact');
});

// ------------------------------------------------------------- subject
test('the failing STEP is what is reported, not "the test"', () => {
  // "Search failed" is what an operator needs. "The test failed" is what they
  // already know.
  const failure = primaryFailure(run({ api_calls: [API_500] }));
  assert.equal(failure.subject, 'Customer Search');
});

test('the worst status explains the failure, not the first one seen', () => {
  // A 503 explains a broken journey better than a 404, which might just be a
  // page that legitimately does not exist.
  const result = correlate({
    observations: run({
      api_calls: [
        { method: 'GET', url: '/api/optional-thing', status: 404, duration_ms: 10 },
        { method: 'POST', url: '/api/customer/search', status: 503, duration_ms: 120 },
      ],
    }),
  });
  assert.equal(result.subject, '/api/customer/search');
});

// ------------------------------------------------------- never throws
test('junk in, no correlation out — this can never break a page', () => {
  for (const junk of [null, undefined, 'nope', 42, { observations: 'no' },
    { observations: [null, 7, {}] }, { observations: run(), history: 'later' }]) {
    assert.doesNotThrow(() => correlate(junk), JSON.stringify(junk));
  }
  assert.equal(describeCorrelation(null), null);
});
