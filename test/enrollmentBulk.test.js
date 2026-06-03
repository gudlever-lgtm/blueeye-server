'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { decideOutcome } = require('../src/services/enrollmentStore');
const { validateCreateCode } = require('../src/validation/enrollmentValidation');
const { makeApp, makeEnrollmentCodesRepo, authHeader } = require('../test-support/fakes');

// ---- decideOutcome: the pure N-uses / expiry / exhaustion decision ----------
test('decideOutcome: invalid when there is no row', () => {
  assert.equal(decideOutcome(undefined).status, 'invalid');
});

test('decideOutcome: expired takes priority over remaining uses', () => {
  assert.equal(decideOutcome({ is_expired: 1, uses_remaining: 5, used_at: null }).status, 'expired');
});

test('decideOutcome: a bulk code can be used N times, then is exhausted', () => {
  let remaining = 3;
  for (let i = 0; i < 3; i += 1) {
    const d = decideOutcome({ is_expired: 0, uses_remaining: remaining, used_at: null });
    assert.equal(d.status, 'ok');
    assert.equal(d.remainingAfter, remaining - 1);
    remaining = d.remainingAfter;
  }
  // N+1: no uses left.
  assert.equal(decideOutcome({ is_expired: 0, uses_remaining: remaining, used_at: null }).status, 'used');
});

test('decideOutcome: pre-migration rows fall back to used_at semantics', () => {
  assert.equal(decideOutcome({ is_expired: 0, uses_remaining: null, used_at: null }).status, 'ok');
  assert.equal(decideOutcome({ is_expired: 0, uses_remaining: null, used_at: '2026-01-01' }).status, 'used');
});

// ---- validation -------------------------------------------------------------
test('validateCreateCode defaults maxUses to 1 and bounds it', () => {
  assert.equal(validateCreateCode({}).value.maxUses, 1);
  assert.equal(validateCreateCode({ maxUses: 25 }).value.maxUses, 25);
  assert.ok(validateCreateCode({ maxUses: 0 }).errors.maxUses);
  assert.ok(validateCreateCode({ maxUses: 99999 }).errors.maxUses);
  assert.ok(validateCreateCode({ maxUses: 2.5 }).errors.maxUses);
});

// ---- POST /enrollment-codes carries maxUses through -------------------------
test('POST /enrollment-codes creates a bulk code and echoes uses', async () => {
  let createdWith = null;
  const repo = makeEnrollmentCodesRepo({
    create: async (input) => { createdWith = input; return { id: 1, code: 'BULK', location_id: null, expires_at: '2099-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z', max_uses: input.maxUses, uses_remaining: input.maxUses }; },
  });
  const res = await request(makeApp({ enrollmentCodesRepo: repo })).post('/enrollment-codes').set('Authorization', authHeader('operator')).send({ maxUses: 50 });
  assert.equal(res.status, 201);
  assert.equal(createdWith.maxUses, 50);
  assert.equal(res.body.max_uses, 50);
  assert.equal(res.body.uses_remaining, 50);
});

test('POST /enrollment-codes rejects an out-of-range maxUses (400)', async () => {
  const res = await request(makeApp()).post('/enrollment-codes').set('Authorization', authHeader('operator')).send({ maxUses: 0 });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.maxUses);
});
