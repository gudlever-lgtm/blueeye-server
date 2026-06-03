'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeArtifactStore, makeEnrollmentCodesRepo, authHeader } = require('../test-support/fakes');

const operator = () => authHeader('operator');

// ---- auth ------------------------------------------------------------------
test('GET /api/enroll/command requires auth (401) and operator+ (403 for viewer)', async () => {
  assert.equal((await request(makeApp()).get('/api/enroll/command')).status, 401);
  assert.equal((await request(makeApp()).get('/api/enroll/command').set('Authorization', authHeader('viewer'))).status, 403);
});

// ---- mint a new code (no codeId) ------------------------------------------
test('GET /api/enroll/command mints a code and returns all three variants (200)', async () => {
  let createdWith = null;
  const repo = makeEnrollmentCodesRepo({
    create: async (input) => { createdWith = input; return { id: 5, code: 'NEWCODE', expires_at: '2099-01-01T00:00:00.000Z', max_uses: input.maxUses, uses_remaining: input.maxUses }; },
  });
  const res = await request(makeApp({ enrollmentCodesRepo: repo })).get('/api/enroll/command?platform=linux-amd64').set('Authorization', operator());
  assert.equal(res.status, 200);
  assert.ok(createdWith, 'a new code was created via the existing flow');
  assert.equal(res.body.code, 'NEWCODE');
  assert.match(res.body.oneLiner, /curl -sSL .*\/enroll\/NEWCODE\/install\.sh \| sh/);
  assert.match(res.body.manual.downloadUrl, /\/enroll\/agent\/linux-amd64$/);
  assert.equal(res.body.manual.checksum, 'a'.repeat(64)); // from the default fake artifact store
  assert.match(res.body.manual.command, /blueeye-agent enroll --code NEWCODE/);
  assert.equal(res.body.expiresAt, '2099-01-01T00:00:00.000Z');
  assert.ok(Array.isArray(res.body.platforms));
});

test('GET /api/enroll/command supports bulk (maxUses + ttlMinutes)', async () => {
  let createdWith = null;
  const repo = makeEnrollmentCodesRepo({
    create: async (input) => { createdWith = input; return { id: 6, code: 'BULK', expires_at: '2099-01-01T00:00:00.000Z', max_uses: input.maxUses, uses_remaining: input.maxUses }; },
  });
  const res = await request(makeApp({ enrollmentCodesRepo: repo })).get('/api/enroll/command?maxUses=10&ttlMinutes=120').set('Authorization', operator());
  assert.equal(res.status, 200);
  assert.equal(createdWith.maxUses, 10);
  assert.equal(createdWith.expiresInMinutes, 120);
  assert.equal(res.body.maxUses, 10);
});

test('GET /api/enroll/command rejects bad maxUses / platform (400)', async () => {
  assert.equal((await request(makeApp()).get('/api/enroll/command?maxUses=0').set('Authorization', operator())).status, 400);
  assert.equal((await request(makeApp()).get('/api/enroll/command?maxUses=99999').set('Authorization', operator())).status, 400);
  assert.equal((await request(makeApp()).get('/api/enroll/command?platform=Bad_Platform').set('Authorization', operator())).status, 400);
});

// ---- reuse an existing code (codeId) --------------------------------------
test('GET /api/enroll/command?codeId reuses an active code', async () => {
  const repo = makeEnrollmentCodesRepo({ findById: async (id) => ({ id, code: 'EXISTING', status: 'active', expires_at: '2099-01-01T00:00:00.000Z', max_uses: 1, uses_remaining: 1 }) });
  const res = await request(makeApp({ enrollmentCodesRepo: repo })).get('/api/enroll/command?codeId=3').set('Authorization', operator());
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'EXISTING');
});

test('GET /api/enroll/command?codeId 404s for missing, 410 for expired/exhausted', async () => {
  const missing = makeEnrollmentCodesRepo({ findById: async () => null });
  assert.equal((await request(makeApp({ enrollmentCodesRepo: missing })).get('/api/enroll/command?codeId=9').set('Authorization', operator())).status, 404);

  const expired = makeEnrollmentCodesRepo({ findById: async (id) => ({ id, code: 'X', status: 'expired', expires_at: '2000-01-01T00:00:00.000Z', max_uses: 1, uses_remaining: 0 }) });
  assert.equal((await request(makeApp({ enrollmentCodesRepo: expired })).get('/api/enroll/command?codeId=9').set('Authorization', operator())).status, 410);

  const exhausted = makeEnrollmentCodesRepo({ findById: async (id) => ({ id, code: 'X', status: 'used', expires_at: '2099-01-01T00:00:00.000Z', max_uses: 5, uses_remaining: 0 }) });
  assert.equal((await request(makeApp({ enrollmentCodesRepo: exhausted })).get('/api/enroll/command?codeId=9').set('Authorization', operator())).status, 410);
});

// ---- checksum null when the platform has no published binary ---------------
test('GET /api/enroll/command returns checksum:null for an unpublished platform', async () => {
  const store = makeArtifactStore({ entries: {} }); // nothing published
  const repo = makeEnrollmentCodesRepo({ create: async () => ({ id: 1, code: 'C', expires_at: '2099-01-01T00:00:00.000Z', max_uses: 1, uses_remaining: 1 }) });
  const res = await request(makeApp({ artifactStore: store, enrollmentCodesRepo: repo })).get('/api/enroll/command?platform=linux-amd64').set('Authorization', operator());
  assert.equal(res.status, 200);
  assert.equal(res.body.manual.checksum, null);
});

// ---- 500 path --------------------------------------------------------------
test('GET /api/enroll/command 500s when code creation throws', async () => {
  const repo = makeEnrollmentCodesRepo({ create: async () => { throw new Error('db down'); } });
  const res = await request(makeApp({ enrollmentCodesRepo: repo })).get('/api/enroll/command').set('Authorization', operator());
  assert.equal(res.status, 500);
});
