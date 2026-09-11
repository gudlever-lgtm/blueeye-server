'use strict';

// Specs for the API-correlation log (docs/service-assurance-v2.md §5).
//
// The security half matters more than the feature half: this column is rendered
// in a UI and read by support, so a credential that reaches it is a credential
// leaked. Everything here is pure — no browser, no clock.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createApiLog, safeUrl, verdictOf, isWorthKeeping, SECRET_PARAMS, MASK } = require('../apiLog');

// ------------------------------------------------------------------ safeUrl
test('every sensitive query parameter is masked, and the rest of the URL survives', () => {
  for (const name of SECRET_PARAMS) {
    const out = safeUrl(`https://fellis.eu/api/x?${name}=super-secret-value&page=2`);
    assert.ok(!out.includes('super-secret-value'), `${name} leaked: ${out}`);
    assert.ok(out.includes(MASK), `${name} not masked: ${out}`);
    assert.ok(out.includes('page=2'), 'a harmless parameter must survive — the URL still has to be readable');
  }
  // Case does not save a leak.
  assert.ok(!safeUrl('https://x.dk/?TOKEN=abc123').includes('abc123'));
  assert.ok(!safeUrl('https://x.dk/?Api_Key=abc123').includes('abc123'));
});

test('credentials in the authority are dropped, not stored', () => {
  const out = safeUrl('https://svc-user:hunter2-correct-horse@fellis.eu/api/session');
  assert.ok(!out.includes('hunter2-correct-horse'));
  assert.ok(!out.includes('svc-user'));
  assert.ok(out.startsWith('https://fellis.eu/'));
});

test('the mask is ASCII, so it survives URL encoding legibly', () => {
  const out = safeUrl('https://x.dk/?token=abc');
  assert.match(out, /token=REDACTED/);
  assert.ok(!out.includes('%E2%80%A2'), 'a bullet mask reaches the screen percent-encoded and stops reading as a redaction');
});

test('an unparseable URL is truncated rather than returned raw at full length', () => {
  const long = `not-a-url-${'x'.repeat(2000)}`;
  assert.equal(safeUrl(long).length, 512);
  assert.equal(safeUrl(null), '');
  assert.equal(safeUrl(undefined), '');
});

// ------------------------------------------------------------ what is kept
test('only the requests that answer the question are kept', () => {
  for (const type of ['xhr', 'fetch', 'document']) assert.equal(isWorthKeeping({ resourceType: type }), true, type);
  for (const type of ['image', 'font', 'stylesheet', 'script', 'media', '', null, undefined]) {
    assert.equal(isWorthKeeping({ resourceType: type }), false, String(type));
  }
});

// ----------------------------------------------------------------- the log
// Playwright gives no request id — the Request OBJECT is the identity across the
// request/response/failure events, so a spec must reuse the same object, exactly
// as the driver does.
const req = (n) => ({ id: n });

test('a call is recorded with its method, masked URL, status and duration', () => {
  let clock = 1000;
  const log = createApiLog({ now: () => clock });
  const r = req(1);
  log.start(r, { method: 'post', url: 'https://fellis.eu/api/auth?token=abc', resourceType: 'xhr' });
  clock = 2200;
  log.finish(r, { status: 401 });

  const [call] = log.calls();
  assert.equal(call.method, 'POST', 'the method is normalised — a table of get/GET/Get reads badly');
  assert.equal(call.status, 401);
  assert.equal(call.duration_ms, 1200);
  assert.equal(call.resource_type, 'xhr');
  assert.match(call.url, /token=REDACTED/);
});

test('a request that never answered is reported, not dropped', () => {
  // Exactly what a hung API looks like, and the run ends before the response.
  const log = createApiLog({ now: () => 0 });
  log.start(req(1), { method: 'GET', url: 'https://fellis.eu/api/slow', resourceType: 'fetch' });
  const [call] = log.calls();
  assert.equal(call.status, 0);
  assert.match(call.error, /no response/);
});

test('a failed request keeps why it failed', () => {
  const log = createApiLog({ now: () => 0 });
  const r = req(1);
  log.start(r, { method: 'GET', url: 'https://ipapi.co/json/', resourceType: 'fetch' });
  log.fail(r, { error: 'net::ERR_BLOCKED_BY_CLIENT' });
  assert.match(log.calls()[0].error, /ERR_BLOCKED_BY_CLIENT/);
  assert.equal(log.calls()[0].status, 0);
});

test('an image is never recorded, however it finishes', () => {
  const log = createApiLog({ now: () => 0 });
  const r = req(1);
  assert.equal(log.start(r, { method: 'GET', url: 'https://x.dk/logo.png', resourceType: 'image' }), false);
  log.finish(r, { status: 200 });
  assert.deepEqual(log.calls(), [], 'a settle for a request we never started must not invent one');
});

test('the log is capped, and it keeps the NEWEST', () => {
  // A single-page app polling every second for five minutes would otherwise
  // write tens of thousands of rows into one JSON column — and a failure is at
  // the END of a run, so the first hundred are the least interesting.
  const log = createApiLog({ now: () => 0, max: 10 });
  for (let i = 0; i < 50; i += 1) {
    const r = req(i);
    log.start(r, { method: 'GET', url: `https://x.dk/api/${i}`, resourceType: 'xhr' });
    log.finish(r, { status: 200 });
  }
  const calls = log.calls();
  assert.equal(calls.length, 10);
  assert.match(calls[calls.length - 1].url, /\/api\/49$/);
});

test('a credential that reached a URL is masked on the way IN', () => {
  // Masked at the boundary rather than at render time, where one forgotten
  // template would leak it.
  const { createRedactor } = require('../../engine/redact');
  const log = createApiLog({ now: () => 0, redact: createRedactor(['hunter2-correct-horse']) });
  const r = req(1);
  log.start(r, { method: 'GET', url: 'https://fellis.eu/cb?ticket=hunter2-correct-horse', resourceType: 'document' });
  log.finish(r, { status: 200 });
  assert.ok(!JSON.stringify(log.calls()).includes('hunter2-correct-horse'));
});

// --------------------------------------------------------------- the verdict
test('the verdict separates the browser, the page and the API', () => {
  const ok = verdictOf({ calls: [{ resource_type: 'document', status: 200 }, { resource_type: 'xhr', status: 200 }] });
  assert.deepEqual([ok.browser, ok.page, ok.api], [true, true, true]);

  const apiDown = verdictOf({ calls: [{ resource_type: 'document', status: 200 }, { resource_type: 'xhr', status: 503 }] });
  assert.deepEqual([apiDown.browser, apiDown.page, apiDown.api], [true, true, false]);
  assert.equal(apiDown.http_status, 503, 'the status worth printing is the API failure, not the healthy page');

  const pageDown = verdictOf({ calls: [{ resource_type: 'document', status: 500 }] });
  assert.equal(pageDown.page, false);
  assert.equal(pageDown.http_status, 500);

  const scriptError = verdictOf({ calls: [{ resource_type: 'document', status: 200 }], consoleErrors: ['TypeError'] });
  assert.equal(scriptError.page, false, 'a page that threw is not a healthy page');
  assert.equal(scriptError.api, true);

  const dead = verdictOf({ calls: [], failedToStart: true });
  assert.deepEqual([dead.browser, dead.page, dead.api], [false, false, false]);
});

test('the worst API status is the one reported, not the first seen', () => {
  const v = verdictOf({ calls: [{ resource_type: 'xhr', status: 404 }, { resource_type: 'xhr', status: 503 }] });
  assert.equal(v.http_status, 503);
});

test('the verdict never throws on the shapes a stored run can actually have', () => {
  for (const input of [undefined, {}, { calls: null }, { calls: [null] }, { calls: [{}] }]) {
    assert.doesNotThrow(() => verdictOf(input), JSON.stringify(input));
  }
});
