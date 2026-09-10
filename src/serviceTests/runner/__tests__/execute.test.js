'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakeDriver } = require('./fakeDriver');
const { executeDefinition, resolveValue, stepLabel } = require('../execute');
const { createRedactor } = require('../../engine/redact');
const { KIND } = require('../classify');

const CREDENTIAL = { username: 'svc-test', secret: 'hunter2-correct-horse' };

// The MVP journey from spec §31, as the designer would save it.
const LOGIN_TEST = {
  version: 1,
  name: 'Customer Login',
  steps: [
    { type: 'open', url: '/login' },
    { type: 'fill', target: { label: 'Username' }, value: '{{credential.username}}' },
    { type: 'fill', target: { label: 'Password' }, value: '{{credential.password}}' },
    { type: 'click', target: { role: 'button', name: 'Login' } },
    { type: 'assert_visible', target: { text: 'Dashboard' } },
    { type: 'logout' },
  ],
};

let clock = 0;
const tick = () => { clock += 100; return clock; };

test('a passing journey runs every step in order and reports pass', async () => {
  clock = 0;
  const driver = makeFakeDriver({ present: ['Dashboard'], visible: ['Dashboard'] });
  const result = await executeDefinition(LOGIN_TEST, { driver, credential: CREDENTIAL, now: tick });

  assert.equal(result.status, 'pass');
  assert.equal(result.failed_step, null);
  assert.equal(result.steps.length, 6);
  assert.deepEqual(result.steps.map((s) => s.status), Array(6).fill('pass'));
  assert.deepEqual(driver.methodsCalled(), ['open', 'fill', 'fill', 'click', 'visible', 'logout']);
});

test('credential references are resolved at execution time, never stored', async () => {
  const driver = makeFakeDriver({ present: ['Dashboard'], visible: ['Dashboard'] });
  await executeDefinition(LOGIN_TEST, { driver, credential: CREDENTIAL, now: tick });

  const fills = driver.calls.filter((c) => c.method === 'fill');
  assert.deepEqual(fills[0].args, ['Username', 'svc-test']);
  assert.deepEqual(fills[1].args, ['Password', 'hunter2-correct-horse']);
  // The definition itself still holds only the reference.
  assert.equal(LOGIN_TEST.steps[2].value, '{{credential.password}}');
});

test('an unresolvable reference is left verbatim rather than becoming an empty string', () => {
  assert.equal(resolveValue('{{credential.password}}', null), '{{credential.password}}');
  assert.equal(resolveValue('{{credential.password}}', { username: 'u' }), '{{credential.password}}');
  assert.equal(resolveValue('{{credential.nope}}', CREDENTIAL), '{{credential.nope}}');
  assert.equal(resolveValue(42, CREDENTIAL), 42);
});

// The security property: a password must not survive into any recorded string.
test('no credential value appears anywhere in the result of a failing run', async () => {
  const driver = makeFakeDriver({
    failOn: { click: new Error('login failed for svc-test with password hunter2-correct-horse') },
  });
  const redact = createRedactor([CREDENTIAL.secret]);
  const result = await executeDefinition(LOGIN_TEST, { driver, credential: CREDENTIAL, redact, now: tick });

  assert.equal(result.status, 'fail');
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(CREDENTIAL.secret), 'the password leaked into the run result');
  assert.ok(serialised.includes('••••••'), 'the value should be masked, not dropped');
});

test('a run stops at the first failure and records the rest as skipped', async () => {
  clock = 0;
  const driver = makeFakeDriver({ failOn: { click: new Error('Timeout 30000ms exceeded') } });
  const result = await executeDefinition(LOGIN_TEST, { driver, credential: CREDENTIAL, now: tick });

  assert.equal(result.status, 'fail');
  assert.equal(result.failed_step, 3, 'the click is step index 3');
  assert.deepEqual(result.steps.map((s) => s.status), ['pass', 'pass', 'pass', 'fail', 'skipped', 'skipped']);
  assert.equal(result.steps.length, 6, 'the whole test is reported, not truncated at the failure');
  assert.ok(!driver.methodsCalled().includes('logout'), 'nothing runs after the failure');
});

test('a 503 on the wire outranks the driver timeout in the explanation', async () => {
  // Exactly the spec §31 failure: the click times out because the auth API is down.
  const driver = makeFakeDriver({
    failOn: { click: new Error('locator.click: Timeout 30000ms exceeded') },
    networkErrors: [{ url: '/api/auth/login', status: 503 }],
  });
  const result = await executeDefinition(LOGIN_TEST, { driver, credential: CREDENTIAL, now: tick });

  assert.equal(result.failure_kind, KIND.HTTP_503);
  assert.equal(result.classification.http_status, 503);
  assert.match(result.classification.likely_cause, /service/i);
  assert.ok(result.classification.evidence.some((e) => e.includes('/api/auth/login')));
});

test('an assertion failure says what was expected and what was found', async () => {
  const driver = makeFakeDriver({ texts: { Greeting: 'Velkommen tilbage' } });
  const def = { version: 1, steps: [{ type: 'assert_text_equals', target: { label: 'Greeting' }, value: 'Farvel' }] };
  const result = await executeDefinition(def, { driver, now: tick });

  assert.equal(result.status, 'fail');
  assert.match(result.error_message, /forventede teksten "Farvel"/);
  assert.match(result.error_message, /Velkommen tilbage/);
});

test('assert_not_visible passes when the element is absent', async () => {
  const driver = makeFakeDriver({ present: [], visible: [] });
  const def = { version: 1, steps: [{ type: 'assert_not_visible', target: { text: 'Fejl' } }] };
  assert.equal((await executeDefinition(def, { driver, now: tick })).status, 'pass');
});

test('a condition runs its block when the element is present', async () => {
  const driver = makeFakeDriver({ present: ['Accepter cookies'] });
  const def = {
    version: 1,
    steps: [
      { type: 'condition', target: { text: 'Accepter cookies' }, then: [{ type: 'click', target: { text: 'Accepter cookies' } }] },
      { type: 'open', url: '/' },
    ],
  };
  const result = await executeDefinition(def, { driver, now: tick });

  assert.equal(result.status, 'pass');
  assert.ok(driver.methodsCalled().includes('click'), 'the cookie banner should have been dismissed');
  assert.deepEqual(result.steps.map((s) => s.status), ['pass', 'pass', 'pass']);
});

test('a condition skips its block when the element is absent — and does not fail the test', async () => {
  const driver = makeFakeDriver({ present: [] });
  const def = {
    version: 1,
    steps: [
      { type: 'condition', target: { text: 'Accepter cookies' }, then: [{ type: 'click', target: { text: 'Accepter cookies' } }] },
      { type: 'open', url: '/' },
    ],
  };
  const result = await executeDefinition(def, { driver, now: tick });

  assert.equal(result.status, 'pass', 'a banner that was not shown is a normal outcome, not a failure');
  assert.ok(!driver.methodsCalled().includes('click'));
  assert.equal(result.steps[1].status, 'skipped');
  assert.match(result.steps[1].message, /Betingelsen/);
});

test('a disabled step is skipped without being run', async () => {
  const driver = makeFakeDriver({});
  const def = { version: 1, steps: [{ type: 'open', url: '/' }, { type: 'refresh', enabled: false }] };
  const result = await executeDefinition(def, { driver, now: tick });

  assert.equal(result.status, 'pass');
  assert.equal(result.steps[1].status, 'skipped');
  assert.ok(!driver.methodsCalled().includes('refresh'));
});

test('login without a usable credential fails as a credential problem, not a page problem', async () => {
  const driver = makeFakeDriver({});
  const def = { version: 1, steps: [{ type: 'login' }] };
  const result = await executeDefinition(def, { driver, credential: null, now: tick });

  assert.equal(result.status, 'fail');
  assert.equal(result.failure_kind, KIND.CREDENTIAL_MISSING);
});

test('assert_http_status checks the status of the most recent request', async () => {
  const driver = makeFakeDriver({ status: 200 });
  const ok = { version: 1, steps: [{ type: 'open', url: '/' }, { type: 'assert_http_status', status: 200 }] };
  assert.equal((await executeDefinition(ok, { driver, now: tick })).status, 'pass');

  const bad = { version: 1, steps: [{ type: 'open', url: '/' }, { type: 'assert_http_status', status: 204 }] };
  const result = await executeDefinition(bad, { driver: makeFakeDriver({ status: 200 }), now: tick });
  assert.equal(result.status, 'fail');
  assert.match(result.error_message, /HTTP 204.*HTTP 200/);
});

test('api_request updates the status the following assertion reads', async () => {
  const driver = makeFakeDriver({ apiStatus: 201 });
  const def = {
    version: 1,
    steps: [{ type: 'api_request', method: 'POST', url: '/api/orders' }, { type: 'assert_http_status', status: 201 }],
  };
  assert.equal((await executeDefinition(def, { driver, now: tick })).status, 'pass');
});

test('collecting failure context never masks the original error', async () => {
  // A driver whose diagnostics themselves throw — the run must still report the
  // real failure rather than the secondary one.
  const driver = makeFakeDriver({ failOn: { click: new Error('the real failure') } });
  driver.consoleErrors = async () => { throw new Error('diagnostics are broken too'); };
  driver.networkErrors = async () => { throw new Error('and so are these'); };

  const def = { version: 1, steps: [{ type: 'click', target: { role: 'button', name: 'Go' } }] };
  const result = await executeDefinition(def, { driver, now: tick });
  assert.equal(result.status, 'fail');
  assert.match(result.error_message, /the real failure/);
});

test('an empty definition is reported as skipped rather than a false pass', async () => {
  const result = await executeDefinition({ version: 1, steps: [] }, { driver: makeFakeDriver({}), now: tick });
  assert.equal(result.status, 'skipped');
});

test('step labels read as plain language, never as a locator', () => {
  assert.equal(stepLabel({ type: 'open', url: '/login' }), 'Åbn /login');
  assert.equal(stepLabel({ type: 'click', target: { role: 'button', name: 'Log ind' } }), 'Klik på knappen "Log ind"');
  assert.equal(stepLabel({ type: 'fill', target: { label: 'Brugernavn' } }), 'Indtast i feltet "Brugernavn"');
  assert.equal(stepLabel({ type: 'wait', ms: 500 }), 'Vent 500 ms');
  // A custom label always wins, so an operator can rename a step.
  assert.equal(stepLabel({ type: 'click', label: 'Godkend ordren' }), 'Godkend ordren');
});

test('onStep reports progress and a broken reporter cannot break the run', async () => {
  const seen = [];
  const driver = makeFakeDriver({ present: ['Dashboard'], visible: ['Dashboard'] });
  const result = await executeDefinition(LOGIN_TEST, {
    driver, credential: CREDENTIAL, now: tick, onStep: (s) => { seen.push(s.status); throw new Error('reporter exploded'); },
  });
  assert.equal(result.status, 'pass');
  assert.equal(seen.length, 6);
});
