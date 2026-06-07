'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeReleaseKeyService, makeEnrollmentCodesRepo, makeSourceStore, authHeader } = require('../test-support/fakes');

// ---- Settings → Agent signing key (admin) ----------------------------------
test('GET /api/settings/agent-release-key returns status to an admin (200, no key material)', async () => {
  const res = await request(makeApp()).get('/api/settings/agent-release-key').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, true);
  assert.ok(!('privateKey' in res.body));
  assert.equal(JSON.stringify(res.body).includes('PRIVATE'), false);
});

test('GET /api/settings/agent-release-key is admin-only (403 for viewer)', async () => {
  const res = await request(makeApp()).get('/api/settings/agent-release-key').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('POST generates the key (201) and returns no key material', async () => {
  const res = await request(makeApp({ releaseKeyService: makeReleaseKeyService({ configured: false }) }))
    .post('/api/settings/agent-release-key').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 201);
  assert.equal(res.body.configured, true);
  assert.equal(JSON.stringify(res.body).includes('PRIVATE'), false);
});

test('POST is refused (409) when a key already exists — write-once', async () => {
  const svc = makeReleaseKeyService({ generate: async () => { const e = new Error('exists'); e.code = 'EXISTS'; throw e; } });
  const res = await request(makeApp({ releaseKeyService: svc })).post('/api/settings/agent-release-key').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'EXISTS');
});

test('DELETE removes the key (200 → not configured); admin-only (403 for operator)', async () => {
  const ok = await request(makeApp()).delete('/api/settings/agent-release-key').set('Authorization', authHeader('admin'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.configured, false);

  const forbidden = await request(makeApp()).delete('/api/settings/agent-release-key').set('Authorization', authHeader('operator'));
  assert.equal(forbidden.status, 403);
});

// ---- Enrollment is gated on the signing key --------------------------------
test('GET /api/enroll/command is blocked (409 NO_RELEASE_KEY) until the signing key is set', async () => {
  const app = makeApp({
    releaseKeyService: makeReleaseKeyService({ configured: false }),
    enrollmentCodesRepo: makeEnrollmentCodesRepo(),
    agentSourceStore: makeSourceStore({ sha256: 's'.repeat(64) }),
  });
  const res = await request(app).get('/api/enroll/command').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NO_RELEASE_KEY');
});
