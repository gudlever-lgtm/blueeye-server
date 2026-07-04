'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeTransactionTestsRepo, authHeader, throwingAsync } = require('../test-support/fakes');

const VALID_TEST = {
  name: 'Login flow',
  type: 'http',
  steps: [
    { name: 'Get homepage', method: 'GET', url: 'https://example.com/', expect_status: 200 },
    { name: 'Login', method: 'POST', url: 'https://example.com/login', body: '{}', expect_status: 200, expect_keyword: 'token', extract: [{ name: 'TOKEN', regex: '"token":"([^"]+)"' }] },
  ],
  secrets: { API_KEY: 'supersecret' },
  agents: ['all'],
  enabled: true,
};

// ---- Auth / RBAC ----

test('GET /api/transaction-tests requires auth (401)', async () => {
  const res = await request(makeApp()).get('/api/transaction-tests');
  assert.equal(res.status, 401);
});

test('POST /api/transaction-tests requires admin (403 for viewer)', async () => {
  const res = await request(makeApp()).post('/api/transaction-tests')
    .set('Authorization', authHeader('viewer')).send(VALID_TEST);
  assert.equal(res.status, 403);
});

test('POST /api/transaction-tests requires admin (403 for operator)', async () => {
  const res = await request(makeApp()).post('/api/transaction-tests')
    .set('Authorization', authHeader('operator')).send(VALID_TEST);
  assert.equal(res.status, 403);
});

test('DELETE /api/transaction-tests/:id requires admin', async () => {
  const repo = makeTransactionTestsRepo();
  await repo.create({ ...VALID_TEST, secrets: {} });
  const res = await request(makeApp({ transactionTestsRepo: repo }))
    .delete('/api/transaction-tests/1').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

// ---- CRUD ----

test('GET /api/transaction-tests returns empty list', async () => {
  const res = await request(makeApp()).get('/api/transaction-tests')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('POST /api/transaction-tests creates a test (admin)', async () => {
  const repo = makeTransactionTestsRepo();
  const res = await request(makeApp({ transactionTestsRepo: repo }))
    .post('/api/transaction-tests').set('Authorization', authHeader('admin')).send(VALID_TEST);
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Login flow');
  assert.equal(res.body.type, 'http');
  assert.equal(res.body.steps.length, 2);
  // Secrets must NOT appear in the response
  assert.equal(res.body.secrets, undefined, 'secrets must not be returned');
  // Only the key name should appear
  assert.deepEqual(res.body.secret_names, ['API_KEY']);
});

test('GET /api/transaction-tests/:id returns 404 for unknown id', async () => {
  const res = await request(makeApp()).get('/api/transaction-tests/9999')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
  assert.ok(res.body.error);
});

test('GET /api/transaction-tests/:id returns 400 for invalid id', async () => {
  const res = await request(makeApp()).get('/api/transaction-tests/abc')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/transaction-tests/:id returns test without secrets', async () => {
  const repo = makeTransactionTestsRepo();
  await repo.create(VALID_TEST);
  const res = await request(makeApp({ transactionTestsRepo: repo }))
    .get('/api/transaction-tests/1').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Login flow');
  assert.equal(res.body.secrets, undefined, 'secrets must not appear');
});

test('PUT /api/transaction-tests/:id updates a test', async () => {
  const repo = makeTransactionTestsRepo();
  await repo.create(VALID_TEST);
  const res = await request(makeApp({ transactionTestsRepo: repo }))
    .put('/api/transaction-tests/1').set('Authorization', authHeader('admin'))
    .send({ ...VALID_TEST, name: 'Renamed flow' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Renamed flow');
  assert.equal(res.body.secrets, undefined);
});

test('PUT /api/transaction-tests/:id returns 404 for unknown test', async () => {
  const res = await request(makeApp()).put('/api/transaction-tests/999')
    .set('Authorization', authHeader('admin')).send(VALID_TEST);
  assert.equal(res.status, 404);
});

test('DELETE /api/transaction-tests/:id removes a test', async () => {
  const repo = makeTransactionTestsRepo();
  await repo.create(VALID_TEST);
  const del = await request(makeApp({ transactionTestsRepo: repo }))
    .delete('/api/transaction-tests/1').set('Authorization', authHeader('admin'));
  assert.equal(del.status, 204);
  const get = await request(makeApp({ transactionTestsRepo: repo }))
    .get('/api/transaction-tests/1').set('Authorization', authHeader('viewer'));
  assert.equal(get.status, 404);
});

test('DELETE /api/transaction-tests/:id returns 404 when not found', async () => {
  const res = await request(makeApp()).delete('/api/transaction-tests/999')
    .set('Authorization', authHeader('admin'));
  assert.equal(res.status, 404);
});

// ---- Validation ----

test('POST /api/transaction-tests returns 400 when name missing', async () => {
  const res = await request(makeApp()).post('/api/transaction-tests')
    .set('Authorization', authHeader('admin')).send({ type: 'http', steps: [] });
  assert.equal(res.status, 400);
  assert.ok(res.body.details);
});

test('POST /api/transaction-tests returns 400 for invalid type', async () => {
  const res = await request(makeApp()).post('/api/transaction-tests')
    .set('Authorization', authHeader('admin')).send({ name: 'X', type: 'smtp', steps: [] });
  assert.equal(res.status, 400);
});

// ---- Read endpoints ----

test('GET /api/transaction-tests/matrix returns shape', async () => {
  const repo = makeTransactionTestsRepo();
  await repo.create(VALID_TEST);
  const res = await request(makeApp({ transactionTestsRepo: repo }))
    .get('/api/transaction-tests/matrix').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.tests));
  assert.ok(Array.isArray(res.body.agent_ids));
  assert.ok(typeof res.body.cells === 'object');
});

test('GET /api/transaction-tests/heatmap returns 400 without test_id', async () => {
  const res = await request(makeApp()).get('/api/transaction-tests/heatmap')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/transaction-tests/heatmap returns 404 for unknown test', async () => {
  const res = await request(makeApp()).get('/api/transaction-tests/heatmap?test_id=999')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /api/transaction-tests/heatmap returns data for known test', async () => {
  const repo = makeTransactionTestsRepo({ heatmapBuckets: async () => [{ agent_id: 1, bucket: 100, avg_latency: 120, fails: 0, samples: 3 }] });
  await repo.create(VALID_TEST);
  const res = await request(makeApp({ transactionTestsRepo: repo }))
    .get('/api/transaction-tests/heatmap?test_id=1').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 1);
});

test('GET /api/transaction-tests/:id/trend returns 404 for unknown test', async () => {
  const res = await request(makeApp()).get('/api/transaction-tests/999/trend')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /api/transaction-tests/:id/trend returns data', async () => {
  const repo = makeTransactionTestsRepo();
  await repo.create(VALID_TEST);
  const res = await request(makeApp({ transactionTestsRepo: repo }))
    .get('/api/transaction-tests/1/trend?days=7').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.test_id, 1);
  assert.equal(res.body.days, 7);
  assert.ok(Array.isArray(res.body.rows));
});

test('GET /api/transaction-tests/:id/results returns 404 for unknown test', async () => {
  const res = await request(makeApp()).get('/api/transaction-tests/999/results')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /api/transaction-tests/:id/results returns results', async () => {
  const repo = makeTransactionTestsRepo({ findResults: async () => [{ id: 1, test_id: 1, agent_id: 2, status: 'ok', duration_ms: 220 }] });
  await repo.create(VALID_TEST);
  const res = await request(makeApp({ transactionTestsRepo: repo }))
    .get('/api/transaction-tests/1/results').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.results.length, 1);
  // Secrets must never appear in results
  assert.equal(res.body.results[0].secrets, undefined);
});

// ---- 500 error handling ----

test('GET /api/transaction-tests returns 500 on repo failure', async () => {
  const repo = makeTransactionTestsRepo({ findAll: throwingAsync() });
  const res = await request(makeApp({ transactionTestsRepo: repo }))
    .get('/api/transaction-tests').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

test('POST /api/transaction-tests returns 500 on repo failure', async () => {
  const repo = makeTransactionTestsRepo({ create: throwingAsync() });
  const res = await request(makeApp({ transactionTestsRepo: repo }))
    .post('/api/transaction-tests').set('Authorization', authHeader('admin')).send(VALID_TEST);
  assert.equal(res.status, 500);
});

test('GET /api/transaction-tests/matrix returns 500 on repo failure', async () => {
  const repo = makeTransactionTestsRepo({ findAll: throwingAsync() });
  const res = await request(makeApp({ transactionTestsRepo: repo }))
    .get('/api/transaction-tests/matrix').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});
