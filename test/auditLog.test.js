'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, authHeader } = require('../test-support/fakes');

// ---- access control --------------------------------------------------------

test('audit log requires auth (401) and admin (operator → 403)', async () => {
  assert.equal((await request(makeApp()).get('/api/audit-log')).status, 401);
  assert.equal((await request(makeApp()).get('/api/audit-log').set('Authorization', authHeader('operator'))).status, 403);
});

test('audit log is gated by audit_log (403 feature_not_available)', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'audit_log' });
  const res = await request(makeApp({ featureGate })).get('/api/audit-log').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'feature_not_available');
  assert.equal(res.body.feature, 'audit_log');
});

test('GET /api/audit-log returns the trail for an admin (200, array)', async () => {
  const res = await request(makeApp()).get('/api/audit-log').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

// ---- recording of real actions ---------------------------------------------

test('a failed login is recorded under category=auth', async () => {
  const app = makeApp();
  await request(app).post('/auth/login').send({ email: 'nobody@example.com', password: 'wrong' });
  const res = await request(app).get('/api/audit-log?category=auth').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].category, 'auth');
  assert.equal(res.body[0].action, 'login_failure');
  assert.equal(res.body[0].outcome, 'failure');
});

test('creating an API token and a user is recorded, filterable by category', async () => {
  const app = makeApp();
  await request(app).post('/api/api-tokens').set('Authorization', authHeader('admin')).send({ name: 'ci' });
  await request(app).post('/users').set('Authorization', authHeader('admin')).send({ email: 'new@example.com', password: 'sup3rsecret!', role: 'viewer' });

  const tokens = await request(app).get('/api/audit-log?category=api_token').set('Authorization', authHeader('admin'));
  assert.equal(tokens.body.length, 1);
  assert.equal(tokens.body[0].action, 'api_token_create');

  const users = await request(app).get('/api/audit-log?category=user').set('Authorization', authHeader('admin'));
  assert.equal(users.body.length, 1);
  assert.equal(users.body[0].action, 'user_create');
  assert.equal(users.body[0].target, 'new@example.com');

  const cats = await request(app).get('/api/audit-log/categories').set('Authorization', authHeader('admin'));
  assert.ok(cats.body.includes('api_token'));
  assert.ok(cats.body.includes('user'));
});
