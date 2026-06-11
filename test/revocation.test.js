'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { issueToken } = require('../src/auth/jwt');
const { requireAuth, setRevocationCheck } = require('../src/auth/middleware');
const { createRevocationRegistry } = require('../src/auth/revocation');

function runAuth(token) {
  const req = { headers: { authorization: `Bearer ${token}` } };
  let status = 200;
  let nexted = false;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  requireAuth(req, res, () => { nexted = true; });
  return { status, nexted, req };
}

test('requireAuth rejects a token issued before the user revocation cutoff', () => {
  const token = issueToken({ id: 42, email: 'a@b.c', role: 'admin' });
  try {
    // Cutoff one hour in the future → the just-issued token is revoked.
    setRevocationCheck((userId) => userId === 42);
    const r = runAuth(token);
    assert.equal(r.status, 401);
    assert.equal(r.nexted, false);
  } finally {
    setRevocationCheck(null);
  }
});

test('requireAuth allows the token when the user is not revoked', () => {
  const token = issueToken({ id: 7, email: 'a@b.c', role: 'viewer' });
  try {
    setRevocationCheck(() => false);
    const r = runAuth(token);
    assert.equal(r.status, 200);
    assert.equal(r.nexted, true);
    assert.equal(r.req.user.id, 7);
  } finally {
    setRevocationCheck(null);
  }
});

test('registry.isRevoked compares iat against the loaded cutoff', async () => {
  const cutoff = new Date('2026-06-11T12:00:00Z');
  const usersRepo = { findRevocations: async () => [{ id: 5, tokens_valid_after: cutoff }] };
  const reg = createRevocationRegistry({ usersRepo, logger: { error() {} } });
  await reg.load();

  const beforeIat = Math.floor(new Date('2026-06-11T11:00:00Z').getTime() / 1000);
  const afterIat = Math.floor(new Date('2026-06-11T13:00:00Z').getTime() / 1000);
  assert.equal(reg.isRevoked(5, beforeIat), true);  // issued before cutoff → revoked
  assert.equal(reg.isRevoked(5, afterIat), false);  // issued after cutoff → valid
  assert.equal(reg.isRevoked(999, beforeIat), false); // user with no cutoff
  reg.stop();
});
