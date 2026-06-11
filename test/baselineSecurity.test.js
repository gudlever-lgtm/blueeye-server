'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createLoginThrottle } = require('../src/auth/loginThrottle');
const { checkPasswordPolicy, PASSWORD_MIN_LENGTH } = require('../src/auth/password');
const { makeApp, authHeader } = require('../test-support/fakes');

// ---------------------------------------------------- login throttle (unit) ---
test('throttle locks a key after maxAttempts and backs off exponentially', () => {
  let nowMs = 0;
  const throttle = createLoginThrottle({
    maxAttempts: 3,
    windowMs: 10_000,
    baseLockoutMs: 1000,
    now: () => nowMs,
  });
  const id = { email: 'a@b.c', ip: '10.0.0.1' };

  assert.equal(throttle.check(id).locked, false);
  throttle.recordFailure(id);
  throttle.recordFailure(id);
  assert.equal(throttle.check(id).locked, false, '2 failures < 3 → still open');
  throttle.recordFailure(id); // 3rd → locks
  assert.equal(throttle.check(id).locked, true);
  assert.equal(throttle.check(id).retryAfterSec, 1); // baseLockoutMs

  // After the first lockout expires, the next batch backs off to 2x.
  nowMs += 1001;
  assert.equal(throttle.check(id).locked, false);
  throttle.recordFailure(id);
  throttle.recordFailure(id);
  throttle.recordFailure(id);
  assert.equal(throttle.check(id).retryAfterSec, 2); // 1000ms * 2^1
});

test('throttle counts per-IP independently of the email', () => {
  let nowMs = 0;
  const throttle = createLoginThrottle({ maxAttempts: 2, baseLockoutMs: 5000, now: () => nowMs });
  // Two different users from the SAME ip → the ip key trips after 2 failures.
  throttle.recordFailure({ email: 'u1@x', ip: '1.2.3.4' });
  throttle.recordFailure({ email: 'u2@x', ip: '1.2.3.4' });
  // A brand-new user, but the shared IP is already locked.
  assert.equal(throttle.check({ email: 'u3@x', ip: '1.2.3.4' }).locked, true);
  // A different IP is unaffected.
  assert.equal(throttle.check({ email: 'u3@x', ip: '9.9.9.9' }).locked, false);
});

test('a successful login clears the counters', () => {
  const throttle = createLoginThrottle({ maxAttempts: 3 });
  const id = { email: 'a@b.c', ip: '10.0.0.1' };
  throttle.recordFailure(id);
  throttle.recordFailure(id);
  throttle.recordSuccess(id);
  throttle.recordFailure(id);
  throttle.recordFailure(id);
  assert.equal(throttle.check(id).locked, false, 'counter reset by the success');
});

// --------------------------------------------------- password policy (unit) ---
test('password policy accepts a sufficiently long + complex password', () => {
  assert.equal(checkPasswordPolicy('Sup3rSecret!').ok, true);
  assert.equal(checkPasswordPolicy('sup3rsecret!').ok, true); // 3 classes is enough
});

test('password policy rejects too-short or too-simple passwords', () => {
  assert.equal(checkPasswordPolicy('short').ok, false); // too short + 1 class
  assert.equal(checkPasswordPolicy('alllowercaseletters').ok, false); // long but 1 class
  assert.equal(checkPasswordPolicy('a'.repeat(PASSWORD_MIN_LENGTH)).ok, false); // long, 1 class
  assert.equal(checkPasswordPolicy(123).ok, false); // not a string
});

// ----------------------------------------------- no multi-tenant routes (404) --
test('no MSP / multi-tenant routes exist (404)', async () => {
  const app = makeApp();
  for (const path of ['/api/tenants', '/api/msp', '/tenants', '/api/msp/agents']) {
    const res = await request(app).get(path).set('Authorization', authHeader('admin'));
    assert.equal(res.status, 404, `${path} must not resolve`);
  }
});
