'use strict';

// The credential redactor is supposed to be the single chokepoint every string
// passes through before it is stored, logged or returned.
//
// It was not. `console_errors` were masked and `api_calls` URLs were masked, and
// `network_errors` — which carry a URL, and a URL is exactly where a credential
// ends up when an application puts one in a query string — went out raw. The
// value landed in service_test_runs.network_errors, and from V3 in
// service_observations as well.
//
// So this sweeps the WHOLE result rather than checking the field that was
// wrong. A field added later that forgets the redactor fails here, which is the
// only way a chokepoint stays one.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { executeDefinition } = require('../src/serviceTests/runner/execute');
const { createRedactor } = require('../src/serviceTests/engine/redact');
const { makeFakeDriver } = require('../src/serviceTests/runner/__tests__/fakeDriver');
const { observationsFromRun } = require('../src/serviceTests/observe/observations');

const SECRET = 'hunter2-correct-horse';
const USERNAME = 'svc-test@kunde.dk';

// A driver that puts the credential into every channel a page can echo it back
// through. None of these is far-fetched: an application that redirects with a
// token in the query string, an error message that quotes the request, a
// console line that logs the body it posted.
function leakyDriver() {
  return makeFakeDriver({
    failOn: { click: new Error(`request failed for ${USERNAME} / ${SECRET}`) },
    consoleErrors: [`POST /login {"password":"${SECRET}"}`, 'unrelated warning'],
    networkErrors: [
      { url: `https://app.test/callback?access_token=${SECRET}&u=${USERNAME}`, status: 0, error: `TLS failed: ${SECRET}` },
      { url: 'https://app.test/ok', status: 500 },
    ],
    apiStatus: 500,
  });
}

async function runWithSecrets() {
  const driver = leakyDriver();
  const redact = createRedactor([SECRET, USERNAME]);
  const result = await executeDefinition({
    version: 1,
    name: 'Login',
    steps: [
      { type: 'fill', target: { label: 'Password' }, value: '{{credential.password}}' },
      { type: 'click', target: { text: 'Sign in' } },
    ],
  }, { driver, credential: { username: USERNAME, secret: SECRET }, redact, accessibilityEnabled: false });
  return { result, driver };
}

test('no credential survives anywhere in a completed run', async () => {
  const { result } = await runWithSecrets();
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(SECRET), `the secret survived in the result:\n${serialised}`);
  assert.ok(!serialised.includes(USERNAME), `the username survived in the result:\n${serialised}`);
});

test('every channel a page can echo through is covered, named one at a time', async () => {
  // Named individually so a failure says WHICH channel regressed rather than
  // "something in the result".
  const { result } = await runWithSecrets();
  const channels = {
    error_message: result.error_message,
    console_errors: result.console_errors,
    network_errors: result.network_errors,
    api_calls: result.api_calls,
    steps: result.steps,
    classification: result.classification,
  };
  for (const [name, value] of Object.entries(channels)) {
    assert.ok(!JSON.stringify(value ?? null).includes(SECRET), `${name} carries the secret`);
  }
});

test('the driver still receives the REAL value — redaction is on the way out, not the way in', async () => {
  // A redactor that masked on the way in would type •••••• into the password
  // field and every login test would fail.
  const { driver } = await runWithSecrets();
  const fill = driver.calls.find((c) => c.method === 'fill');
  assert.equal(fill.args[1], SECRET);
});

test('and nothing survives into the observations derived from that run', async () => {
  // V3 reads a completed run and writes typed facts to a second table. Anything
  // the run still carried would be copied there — which is how one leak becomes
  // two places to find it.
  const { result } = await runWithSecrets();
  const facts = observationsFromRun({ ...result, id: 1, test_id: 1, test_name: 'Login', ended_at: new Date() });
  assert.ok(facts.length, 'the run produced no observations, so this spec proves nothing');
  const serialised = JSON.stringify(facts);
  assert.ok(!serialised.includes(SECRET), `the secret reached the observations:\n${serialised}`);
  assert.ok(!serialised.includes(USERNAME));
});

test('a run with no credential is unchanged — the redactor masks values, not shapes', async () => {
  // The blunt rule is "any occurrence of a known secret becomes ••••••". With no
  // secrets there is nothing to occur, and a run must come back exactly as it
  // was rather than peppered with masks.
  const driver = makeFakeDriver({
    failOn: { click: new Error('Timeout 30000ms exceeded') },
    networkErrors: [{ url: 'https://app.test/api/search', status: 500, error: 'server error' }],
    consoleErrors: ['Uncaught TypeError: x is not a function'],
  });
  const result = await executeDefinition({
    version: 1, name: 'Search', steps: [{ type: 'click', target: { text: 'Go' } }],
  }, { driver, credential: null, redact: createRedactor([]), accessibilityEnabled: false });

  assert.match(result.error_message, /Timeout 30000ms exceeded/);
  assert.equal(result.network_errors[0].url, 'https://app.test/api/search');
  assert.match(result.console_errors[0], /Uncaught TypeError/);
  assert.ok(!JSON.stringify(result).includes('••••••'), 'a run with no secrets came back masked');
});

test('a short value is not masked, and that is deliberate', async () => {
  // Masking a two-character password would turn every stray "ab" in a log into
  // a mask and make the output useless. Such a password is a problem to refuse
  // at entry, not to paper over here — pinned so the rule is a decision rather
  // than a surprise.
  const redact = createRedactor(['ab']);
  assert.equal(redact.text('a log line containing ab somewhere'), 'a log line containing ab somewhere');
});
