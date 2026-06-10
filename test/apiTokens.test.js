'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, authHeader } = require('../test-support/fakes');
const { generateApiToken, hashApiToken, looksLikeApiToken } = require('../src/lib/apiToken');

// ---- token crypto helper ---------------------------------------------------

test('generateApiToken mints a prefixed token, stores only its hash', () => {
  const { token, hash, prefix } = generateApiToken();
  assert.ok(token.startsWith('blueeye_'));
  assert.ok(looksLikeApiToken(token));
  assert.equal(hash, hashApiToken(token));
  assert.notEqual(hash, token); // never store the plaintext
  assert.ok(token.startsWith(prefix));
  // A JWT (has dots) is not mistaken for an API token.
  assert.equal(looksLikeApiToken('a.b.c'), false);
});

// ---- admin routes (gated by api_access) ------------------------------------

test('POST /api/api-tokens returns the plaintext token exactly once (admin)', async () => {
  const app = makeApp();
  const res = await request(app).post('/api/api-tokens')
    .set('Authorization', authHeader('admin')).send({ name: 'CI', role: 'operator' });
  assert.equal(res.status, 201);
  assert.ok(res.body.token.startsWith('blueeye_'));
  assert.equal(res.body.role, 'operator');
  assert.ok(res.body.token_prefix);
  assert.equal(res.body.token_hash, undefined); // hash never leaves the server

  // The list never exposes the secret or hash.
  const list = await request(app).get('/api/api-tokens').set('Authorization', authHeader('admin'));
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].token, undefined);
  assert.equal(list.body[0].token_hash, undefined);
});

test('POST /api/api-tokens validates the body (400)', async () => {
  const res = await request(makeApp()).post('/api/api-tokens')
    .set('Authorization', authHeader('admin')).send({ name: '', role: 'wizard' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.name);
  assert.ok(res.body.details.role);
});

test('api-tokens require admin (operator → 403) and auth (→ 401)', async () => {
  assert.equal((await request(makeApp()).get('/api/api-tokens')).status, 401);
  assert.equal((await request(makeApp()).get('/api/api-tokens').set('Authorization', authHeader('operator'))).status, 403);
});

test('api-tokens are gated by api_access (403 feature_not_available)', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'api_access' });
  const res = await request(makeApp({ featureGate })).get('/api/api-tokens').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'feature_not_available');
  assert.equal(res.body.feature, 'api_access');
});

test('DELETE /api/api-tokens/:id revokes, then 404', async () => {
  const app = makeApp();
  const created = await request(app).post('/api/api-tokens').set('Authorization', authHeader('admin')).send({ name: 'temp' });
  const id = created.body.id;
  assert.equal((await request(app).delete(`/api/api-tokens/${id}`).set('Authorization', authHeader('admin'))).status, 204);
  // A revoked token is still listed but flagged revoked.
  const list = await request(app).get('/api/api-tokens').set('Authorization', authHeader('admin'));
  assert.equal(list.body[0].revoked, true);
  assert.equal((await request(app).delete('/api/api-tokens/9999').set('Authorization', authHeader('admin'))).status, 404);
});

// ---- authenticating with an API token --------------------------------------

test('a minted token authenticates API calls via X-API-Key and Bearer', async () => {
  const app = makeApp();
  const created = await request(app).post('/api/api-tokens')
    .set('Authorization', authHeader('admin')).send({ name: 'reader', role: 'viewer' });
  const token = created.body.token;

  // X-API-Key header
  const r1 = await request(app).get('/license/status').set('X-API-Key', token);
  assert.equal(r1.status, 200);
  // Authorization: Bearer <token>
  const r2 = await request(app).get('/license/status').set('Authorization', `Bearer ${token}`);
  assert.equal(r2.status, 200);
});

test('an invalid or revoked API token is rejected (401)', async () => {
  const app = makeApp();
  assert.equal((await request(app).get('/license/status').set('X-API-Key', 'blueeye_not-a-real-token')).status, 401);

  const created = await request(app).post('/api/api-tokens').set('Authorization', authHeader('admin')).send({ name: 'short-lived' });
  const token = created.body.token;
  await request(app).delete(`/api/api-tokens/${created.body.id}`).set('Authorization', authHeader('admin'));
  assert.equal((await request(app).get('/license/status').set('X-API-Key', token)).status, 401);
});

test("a viewer token cannot reach admin-only endpoints (403)", async () => {
  const app = makeApp();
  const created = await request(app).post('/api/api-tokens')
    .set('Authorization', authHeader('admin')).send({ name: 'reader', role: 'viewer' });
  const res = await request(app).get('/users').set('X-API-Key', created.body.token);
  assert.equal(res.status, 403); // requireRole(admin) blocks the viewer principal
});
