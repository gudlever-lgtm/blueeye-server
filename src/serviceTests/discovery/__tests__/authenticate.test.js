'use strict';

// Signing in before a crawl.
//
// Most of these are about what this REFUSES. Signing in changes what a crawl can
// reach and what it can break: anonymous, a "Delete" button is usually
// unreachable; signed in, it deletes. And a crawl that loses its session halfway
// will happily map the public site and report it as the authenticated
// application — which is worse than not having the feature, because the map
// would be trusted.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  canSignInWith, signInStepsFromDetectedLogin, sessionLost, describeAuthentication,
} = require('../authenticate');

const loginTest = (over = {}) => ({
  application_id: 1,
  credential_id: 2,
  enabled: true,
  definition: {
    steps: [
      { type: 'open', url: '/login' },
      { type: 'fill', target: { label: 'Email' }, value: '{{credential.username}}' },
      { type: 'fill', target: { label: 'Password' }, value: '{{credential.password}}' },
      { type: 'click', target: { role: 'button', name: 'Log ind' } },
    ],
  },
  ...over,
});

// ------------------------------------------------------- replaying a test
test('a proper login test is usable', () => {
  assert.deepEqual(canSignInWith(loginTest(), { applicationId: 1 }), { ok: true });
});

test('a test that does more than sign in is refused — discovery only reads', () => {
  // Replaying it would leave data behind on every single discovery.
  const res = canSignInWith(loginTest({
    definition: { steps: [...loginTest().definition.steps, { type: 'api_request', method: 'POST', url: '/api/cases' }] },
  }), { applicationId: 1 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /does more than sign in/);
});

test('a test that never actually signs in is refused', () => {
  // It would "succeed", leave the crawl anonymous, and the discovery would be
  // reported as authenticated. Silent and completely wrong.
  const res = canSignInWith(loginTest({
    definition: { steps: [{ type: 'open', url: '/' }, { type: 'assert_visible', target: { text: 'Welcome' } }] },
  }), { applicationId: 1 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /never signs in/);
});

test('a sign-in test with no login selected is refused', () => {
  const res = canSignInWith(loginTest({ credential_id: null }), { applicationId: 1 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no login selected/);
});

test('another application\'s test is refused — a sign-in is about one service', () => {
  const res = canSignInWith(loginTest({ application_id: 9 }), { applicationId: 1 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /different application/);
});

test('every refusal says why, so it can be repaired', () => {
  for (const input of [null, undefined, 'nope', {}, loginTest({ enabled: false }),
    loginTest({ definition: { steps: [] } })]) {
    const res = canSignInWith(input, { applicationId: 1 });
    assert.equal(res.ok, false);
    assert.ok(res.reason && res.reason.length > 8, JSON.stringify(input));
  }
});

// ------------------------------------ the form discovery already found
test('the detected login form becomes sign-in steps — no prior test needed', () => {
  // The answer to the chicken-and-egg. The anonymous pass found the form; the
  // rediscover fills it in.
  const steps = signInStepsFromDetectedLogin({
    possible: true, confidence: 'high', url: 'https://app.test/login',
    usernameField: { label: 'Email' }, passwordField: { label: 'Password' },
    submitLabel: 'Log ind',
  });
  assert.deepEqual(steps.map((s) => s.type), ['open', 'fill', 'fill', 'click']);
  // The credential is a REFERENCE, never a value — the same rule the recorder
  // follows, for the same reason.
  assert.equal(steps[1].value, '{{credential.username}}');
  assert.equal(steps[2].value, '{{credential.password}}');
  assert.deepEqual(steps[3].target, { role: 'button', name: 'Log ind' });
});

test('a weak detection produces nothing rather than a guess', () => {
  // A speculative sign-in against a form that is not a login form types a
  // username into somebody's search box and presses enter.
  assert.equal(signInStepsFromDetectedLogin({ possible: true, confidence: 'low', url: '/x', passwordField: {} }), null);
  assert.equal(signInStepsFromDetectedLogin({ possible: false, confidence: 'high', url: '/x', passwordField: {} }), null);
  // No password field means it is not a login form, whatever else was detected.
  assert.equal(signInStepsFromDetectedLogin({ possible: true, confidence: 'high', url: '/x', usernameField: {} }), null);
  assert.equal(signInStepsFromDetectedLogin(null), null);
});

test('a form with no username field still works — plenty of sites ask only for a password', () => {
  const steps = signInStepsFromDetectedLogin({
    possible: true, confidence: 'high', url: '/unlock', passwordField: { name: 'pw' },
  });
  assert.deepEqual(steps.map((s) => s.type), ['open', 'fill', 'click']);
});

// ------------------------------------------------------ losing the session
test('a password field appearing mid-crawl means the session has gone', () => {
  // The failure this whole check exists for.
  const res = sessionLost({ url: 'https://app.test/cases', inputs: [{ type: 'password' }] });
  assert.equal(res.lost, true);
  assert.match(res.reason, /session has gone/);
});

test('being sent back to the sign-in page means the session has gone', () => {
  const res = sessionLost({ url: 'https://app.test/login?next=/cases' }, { loginUrl: 'https://app.test/login' });
  assert.equal(res.lost, true);
  assert.match(res.reason, /sent back to the sign-in page/);
});

test('a "Log in" LINK in a header is not a lost session', () => {
  // A false "lost" merely stops a crawl early and says why. A false "still fine"
  // produces a map of the wrong thing — so this is conservative, but it must not
  // be so jumpy that a normal page trips it.
  const res = sessionLost({
    url: 'https://app.test/cases',
    title: 'Cases — Customer Portal',
    links: [{ text: 'Log in' }, { text: 'Cases' }, { text: 'Reports' }, { text: 'Settings' }, { text: 'Help' }],
    inputs: [{ type: 'search' }],
  });
  assert.equal(res.lost, false);
});

test('a bare page titled "Log ind" with nothing on it IS a lost session', () => {
  const res = sessionLost({ url: 'https://app.test/x', title: 'Log ind', links: [], inputs: [] });
  assert.equal(res.lost, true);
});

test('junk never reports a lost session', () => {
  // Guessing "lost" on junk would abort healthy crawls.
  for (const junk of [null, undefined, 'nope', 42, {}, []]) {
    assert.equal(sessionLost(junk).lost, false, JSON.stringify(junk));
  }
});

// ---------------------------------------------------------- what it says
test('a discovery that could not sign in says so plainly', () => {
  // It must never quietly return the public site as though it were the whole
  // application.
  const text = describeAuthentication({ requested: true, authenticated: false, note: 'that test has no login selected' });
  assert.match(text, /Could not sign in/);
  assert.match(text, /public site only/);
});

test('a lost session is reported with how far it got', () => {
  const text = describeAuthentication({
    requested: true, authenticated: true, pages: 40, authenticatedPages: 12, sessionLostAtPage: 12,
  });
  assert.match(text, /session was lost after 12 pages/);
  assert.match(text, /the rest are the public site/);
});

test('a clean authenticated discovery leads with what it found behind the login', () => {
  // The only reason to do this at all.
  const text = describeAuthentication({ requested: true, authenticated: true, pages: 40, authenticatedPages: 31 });
  assert.match(text, /31 of 40 pages were only reachable once signed in/);
});

test('an anonymous discovery says nothing about authentication', () => {
  assert.equal(describeAuthentication({ requested: false }), null);
  assert.equal(describeAuthentication(), null);
});
