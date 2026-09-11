'use strict';

// Evidence (V2 §10) — "gem evidensen", and the sentence beside it: *ingen
// passwords, tokens, cookies eller authorization headers*.
//
// So half of these specs assemble evidence from a run and then go looking for a
// secret in the result. The guarantee is structural — this module reads only
// columns the runner already masked on the way in, and adds no new source — but
// a guarantee nobody checks is folklore.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evidenceFor, targetOf, slowestStep, FORBIDDEN_KEYS } = require('../evidence');
const { baselineFrom, compare } = require('../baseline');

const RUN = {
  id: 42,
  test_id: 7,
  status: 'fail',
  duration_ms: 4700,
  browser: 'chromium',
  trigger_source: 'schedule',
  test_version: 3,
  started_at: new Date('2026-09-11T10:00:00Z'),
  ended_at: new Date('2026-09-11T10:00:04Z'),
  failure_kind: 'http_5xx',
  error_message: 'The server rejected the request.',
  screenshot_path: 'runs/42.webp',
  console_errors: ['TypeError: x is not a function'],
  network_errors: [{ url: 'https://api.kunde.dk/x', error: 'net::ERR_FAILED' }],
  api_calls: [
    { method: 'POST', url: 'https://api.kunde.dk/auth/login?token=REDACTED', status: 200, duration_ms: 320, resource_type: 'xhr', verdict: 'ok' },
    { method: 'GET', url: 'https://api.kunde.dk/customers', status: 500, duration_ms: 2100, resource_type: 'fetch', verdict: 'failed' },
    { method: 'GET', url: 'https://api.kunde.dk/never', status: 0, duration_ms: 30000, resource_type: 'fetch', verdict: 'failed' },
    { method: 'GET', url: 'https://cdn.kunde.dk/logo.png', status: 200, duration_ms: 12, resource_type: 'image' },
  ],
  steps: [
    { position: 0, step_type: 'open', label: 'Open /login', status: 'pass', duration_ms: 600, detail: { url: 'https://kunde.dk/login' } },
    { position: 1, step_type: 'fill', label: 'Fill Password', status: 'pass', duration_ms: 40, target: { label: 'Kodeord' } },
    {
      position: 2,
      step_type: 'click',
      label: 'Click "Log ind"',
      status: 'fail',
      duration_ms: 3000,
      message: 'The server rejected the request.',
      detail: { url: 'https://kunde.dk/login', target: { role: 'button', name: 'Log ind' } },
    },
  ],
};

test('evidence gathers what was observed into one shape', () => {
  const e = evidenceFor(RUN);
  assert.equal(e.run.id, 42);
  assert.equal(e.run.duration_ms, 4700);
  assert.equal(e.page.url, 'https://kunde.dk/login');
  assert.equal(e.page.failure_kind, 'http_5xx');
  assert.equal(e.steps.length, 3);
  assert.equal(e.screenshot.available, true);
});

test('the failing step is named with what it was pointing at', () => {
  const e = evidenceFor(RUN);
  assert.equal(e.failures.step.position, 2);
  // Selector information, in words — the spec asks for it and an operator
  // cannot read a hint bag.
  assert.match(e.failures.step.target_label, /Log ind/);
  assert.equal(e.steps[2].target.role, 'button');
});

test('failed calls are separated from the rest, and status 0 counts as failed', () => {
  const e = evidenceFor(RUN);
  // Status 0 means the request never completed — a DNS failure, a refused
  // connection — and it reads as "fine" to anything comparing with >= 400.
  assert.equal(e.api.failed, 2);
  assert.deepEqual(e.failures.api.map((c) => c.status).sort(), [0, 500]);
});

test('images and fonts are not evidence', () => {
  const e = evidenceFor(RUN);
  // A page load is a hundred of them and none says whether the service works.
  assert.equal(e.api.total, 3);
  assert.ok(!e.api.calls.some((c) => /logo\.png/.test(c.url)));
});

test('the slowest calls are surfaced, because that is the question after "what failed"', () => {
  const e = evidenceFor(RUN);
  assert.equal(e.api.slowest[0].duration_ms, 30000);
  assert.equal(e.timings.slowest_step.position, 2);
  assert.equal(e.timings.slowest_step.duration_ms, 3000);
});

test('no secret appears anywhere in the assembled record', () => {
  // The masking happens on the way IN, so this asserts the guarantee rather
  // than creating it — but a guarantee nobody checks is folklore.
  const e = evidenceFor(RUN);
  const text = JSON.stringify(e).toLowerCase();
  // The one place a secret-shaped word may legitimately appear is a field LABEL
  // the operator typed ("Kodeord"), which names a field and reveals nothing.
  for (const key of FORBIDDEN_KEYS) {
    const matches = text.split(`"${key}"`).length - 1;
    assert.equal(matches, 0, `evidence carries a "${key}" field`);
  }
  // And a masked URL stays masked.
  assert.ok(!text.includes('hunter2'));
  assert.match(JSON.stringify(e), /REDACTED/, 'the masked query value is kept as the mask, not dropped silently');
});

test('performance rides along as metadata, and says unknown when it does not know', () => {
  const thin = compare(RUN.duration_ms, baselineFrom([800, 900]));
  const e = evidenceFor(RUN, { baseline: thin });
  assert.equal(e.timings.baseline.verdict, 'unknown');
  assert.equal(e.timings.total_label, '4.7 s');

  const real = compare(RUN.duration_ms, baselineFrom([820, 910, 870, 880, 840, 900, 860]));
  assert.equal(evidenceFor(RUN, { baseline: real }).timings.baseline.verdict, 'slow');
});

test('a run with nothing in it produces an empty record, not a crash', () => {
  assert.equal(evidenceFor(null), null);
  assert.equal(evidenceFor('nope'), null);
  const bare = evidenceFor({ id: 1, status: 'pass' });
  assert.equal(bare.api.total, 0);
  assert.equal(bare.steps.length, 0);
  assert.equal(bare.failures.step, null);
  assert.equal(bare.page.url, null);
  assert.equal(bare.screenshot.available, false);
  assert.equal(bare.timings.total_ms, null);

  // Junk in the arrays is skipped rather than thrown on.
  const junk = evidenceFor({ id: 1, steps: [null, 42], api_calls: [null, 'x', { url: 'https://a.dk' }] });
  assert.equal(junk.api.total, 1);
});

test('targetOf finds the target wherever the runner put it', () => {
  assert.deepEqual(targetOf({ target: { id: 'a' } }), { id: 'a' });
  assert.deepEqual(targetOf({ detail: { target: { id: 'b' } } }), { id: 'b' });
  assert.equal(targetOf({}), null);
  assert.equal(targetOf(null), null);
  assert.equal(targetOf({ target: 'not an object' }), null);
});

test('slowestStep ignores unmeasured steps rather than calling them instant', () => {
  assert.equal(slowestStep([]), null);
  assert.equal(slowestStep([{ position: 0, duration_ms: null }]), null);
  const worst = slowestStep([
    { position: 0, duration_ms: null }, { position: 1, duration_ms: 50 }, { position: 2, duration_ms: 900 },
  ]);
  assert.equal(worst.position, 2);
});
