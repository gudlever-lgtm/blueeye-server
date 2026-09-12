'use strict';

// Accessibility inside a run (V2 §9).
//
// The rules themselves are argued with in rules.test.js. This is about the one
// promise the feature rests on: a finding is reported BESIDE the result and can
// never become the result. A check that can turn a build red is a check people
// switch off, and a switched-off check protects nobody.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakeDriver } = require('../../runner/__tests__/fakeDriver');
const { executeDefinition } = require('../../runner/execute');

const TEST = {
  version: 1,
  name: 'Front page',
  steps: [{ type: 'open', url: '/' }, { type: 'assert_visible', target: { text: 'Welcome' } }],
};

// A page with problems on it: no lang, an unnamed button, an image with no alt.
const BROKEN_PAGE = {
  document: { lang: '', title: 'Home', url: 'https://app.test/' },
  nodes: [
    { kind: 'button', tag: 'button', selector: '#submit' },
    { kind: 'image', tag: 'img', selector: 'img.hero', alt: null },
  ],
  headings: [{ level: 1, text: 'Welcome' }],
};

const withSnapshot = (driver, snapshot) => ({ ...driver, accessibilitySnapshot: async () => snapshot });

let clock = 0;
const tick = () => { clock += 100; return clock; };
const run = (driver, opts = {}) => {
  clock = 0;
  return executeDefinition(TEST, { driver, now: tick, ...opts });
};

test('findings ride alongside a passing run and leave the status alone', async () => {
  const base = makeFakeDriver({ present: ['Welcome'], visible: ['Welcome'] });
  const result = await run(withSnapshot(base, BROKEN_PAGE));

  // The whole promise of the feature, in one assertion.
  assert.equal(result.status, 'pass', 'an accessibility finding must never fail a run');
  assert.ok(result.accessibility, 'the audit was not attached');
  assert.equal(result.accessibility.counts.serious, 3);
  assert.equal(result.accessibility.url, 'https://app.test/');
  assert.equal(result.failure_kind, null);
  assert.equal(result.error_message, null);
});

test('a failing run still reports what the page looked like', async () => {
  // The page that broke is the one most worth auditing, and a run that fails is
  // exactly when nobody would think to look.
  const base = makeFakeDriver({ present: [], visible: [] });
  const result = await run(withSnapshot(base, BROKEN_PAGE));

  assert.equal(result.status, 'fail');
  assert.ok(result.accessibility, 'a failing run dropped its accessibility report');
  assert.ok(result.accessibility.counts.total > 0);
});

test('not collected is not the same as clean', async () => {
  // Three ways a run legitimately has no report, and none of them may look like
  // a page that passed.
  const base = makeFakeDriver({ present: ['Welcome'], visible: ['Welcome'] });

  // An older worker whose driver predates the method.
  assert.equal((await run(base)).accessibility, null);

  // A page that would not evaluate — navigated away, closed, cross-origin.
  assert.equal((await run(withSnapshot(base, null))).accessibility, null);

  // Turned off.
  assert.equal((await run(withSnapshot(base, BROKEN_PAGE), { accessibilityEnabled: false })).accessibility, null);
});

test('a clean page reports zero findings AND what it looked at', async () => {
  const base = makeFakeDriver({ present: ['Welcome'], visible: ['Welcome'] });
  const result = await run(withSnapshot(base, {
    document: { lang: 'en', title: 'Home', url: 'https://app.test/' },
    nodes: [{ kind: 'button', tag: 'button', text: 'Sign in' }],
    headings: [{ level: 1, text: 'Welcome' }],
  }));

  assert.deepEqual(result.accessibility.findings, []);
  // Zero findings over zero elements is a page nobody looked at. The counts are
  // what let a reader tell that apart from a page that is genuinely clean.
  assert.equal(result.accessibility.checked.elements, 1);
});

test('a collector that hit its own ceiling says so rather than looking clean', async () => {
  const base = makeFakeDriver({ present: ['Welcome'], visible: ['Welcome'] });
  const result = await run(withSnapshot(base, {
    document: { lang: 'en', title: 'Home', url: 'https://app.test/' },
    nodes: [], headings: [], truncated: true,
  }));
  assert.equal(result.accessibility.collection_truncated, true);
});

test('an audit that throws loses the report, never the run', async () => {
  const base = makeFakeDriver({ present: ['Welcome'], visible: ['Welcome'] });
  const exploding = { ...base, accessibilitySnapshot: async () => { throw new Error('page closed'); } };
  const result = await run(exploding);

  assert.equal(result.status, 'pass', 'a broken audit took the run down with it');
  assert.equal(result.accessibility, null);
});

test('the audit runs last and does not disturb what the run already decided', async () => {
  const base = makeFakeDriver({ present: [], visible: [] });
  const before = await run(base);
  const after = await run(withSnapshot(base, BROKEN_PAGE));

  // Everything the run concluded is identical with and without the audit. If
  // the audit could move any of these, it could move what wakes somebody up.
  for (const key of ['status', 'failed_step', 'error_message', 'failure_kind']) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(after.steps.length, before.steps.length);
});
