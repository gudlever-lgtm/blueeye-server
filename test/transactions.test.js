'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeTransactionsRepo, authHeader, throwingAsync } = require('../test-support/fakes');

const HTTP_TEST = {
  name: 'Login flow',
  type: 'http',
  config: { steps: [
    { url: 'https://example.com/', expectStatus: 200 },
    { url: 'https://example.com/login', method: 'POST', expectStatus: 200, extract: { name: 'TOKEN', pattern: '"token":"([^"]+)"' } },
  ] },
  thresholds: { consecutive_fails: 3, latency_ms: 2000 },
};
const TCP_TEST = { name: 'DB reachability', type: 'tcp', config: { host: 'db.internal', port: 5432 } };
const DNS_TEST = { name: 'Resolve site', type: 'dns', config: { host: 'example.com', record: 'A' } };

const app = (repo) => makeApp(repo ? { transactionsRepo: repo } : {});

// ---- Auth / RBAC ----

test('GET /api/transactions requires auth (401)', async () => {
  const res = await request(makeApp()).get('/api/transactions');
  assert.equal(res.status, 401);
});

test('POST /api/transactions is 403 for viewer and operator, 201 for admin', async () => {
  const repo = makeTransactionsRepo();
  const v = await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('viewer')).send(HTTP_TEST);
  assert.equal(v.status, 403);
  const o = await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('operator')).send(HTTP_TEST);
  assert.equal(o.status, 403);
  const a = await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('admin')).send(HTTP_TEST);
  assert.equal(a.status, 201);
  assert.equal(a.body.type, 'http');
  assert.equal(a.body.config.steps.length, 2);
});

test('POST accepts tcp and dns tests', async () => {
  const repo = makeTransactionsRepo();
  const tcp = await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('admin')).send(TCP_TEST);
  assert.equal(tcp.status, 201);
  assert.equal(tcp.body.config.port, 5432);
  const dns = await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('admin')).send(DNS_TEST);
  assert.equal(dns.status, 201);
  assert.equal(dns.body.config.record, 'A');
});

// ---- CRUD ----

test('GET /api/transactions returns an empty list', async () => {
  const res = await request(makeApp()).get('/api/transactions').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('GET /api/transactions/:id — 400 invalid id, 404 unknown, 200 known', async () => {
  const repo = makeTransactionsRepo();
  await repo.create({ ...HTTP_TEST });
  assert.equal((await request(app(repo)).get('/api/transactions/abc').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app(repo)).get('/api/transactions/9999').set('Authorization', authHeader('viewer'))).status, 404);
  const ok = await request(app(repo)).get('/api/transactions/1').set('Authorization', authHeader('viewer'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'Login flow');
});

test('PUT /api/transactions/:id updates (admin) and 404 for unknown', async () => {
  const repo = makeTransactionsRepo();
  await repo.create({ ...HTTP_TEST });
  const upd = await request(app(repo)).put('/api/transactions/1').set('Authorization', authHeader('admin')).send({ ...HTTP_TEST, name: 'Renamed' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Renamed');
  assert.equal((await request(app(repo)).put('/api/transactions/999').set('Authorization', authHeader('admin')).send(HTTP_TEST)).status, 404);
  assert.equal((await request(app(repo)).put('/api/transactions/1').set('Authorization', authHeader('viewer')).send(HTTP_TEST)).status, 403);
});

test('DELETE /api/transactions/:id removes (admin), 404 when missing, 403 for viewer', async () => {
  const repo = makeTransactionsRepo();
  await repo.create({ ...HTTP_TEST });
  assert.equal((await request(app(repo)).delete('/api/transactions/1').set('Authorization', authHeader('viewer'))).status, 403);
  const del = await request(app(repo)).delete('/api/transactions/1').set('Authorization', authHeader('admin'));
  assert.equal(del.status, 204);
  assert.equal((await request(app(repo)).get('/api/transactions/1').set('Authorization', authHeader('viewer'))).status, 404);
  assert.equal((await request(app(repo)).delete('/api/transactions/999').set('Authorization', authHeader('admin'))).status, 404);
});

// ---- Agent assignment ----

test('PUT /api/transactions/:id/agents assigns agents (admin)', async () => {
  const repo = makeTransactionsRepo();
  await repo.create({ ...HTTP_TEST });
  const res = await request(app(repo)).put('/api/transactions/1/agents').set('Authorization', authHeader('admin')).send({ agent_ids: [3, 7, 7] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.agent_ids, [3, 7]); // de-duped
  const get = await request(app(repo)).get('/api/transactions/1').set('Authorization', authHeader('viewer'));
  assert.deepEqual(get.body.agent_ids, [3, 7]);
});

test('PUT /:id/agents — 404 unknown test, 400 invalid agent_ids, 403 viewer', async () => {
  const repo = makeTransactionsRepo();
  await repo.create({ ...HTTP_TEST });
  assert.equal((await request(app(repo)).put('/api/transactions/999/agents').set('Authorization', authHeader('admin')).send({ agent_ids: [1] })).status, 404);
  assert.equal((await request(app(repo)).put('/api/transactions/1/agents').set('Authorization', authHeader('admin')).send({ agent_ids: 'nope' })).status, 400);
  assert.equal((await request(app(repo)).put('/api/transactions/1/agents').set('Authorization', authHeader('admin')).send({ agent_ids: [0] })).status, 400);
  assert.equal((await request(app(repo)).put('/api/transactions/1/agents').set('Authorization', authHeader('viewer')).send({ agent_ids: [1] })).status, 403);
});

// ---- Validation (400 invalid config) ----

test('POST returns 400 for missing name and unknown type', async () => {
  assert.equal((await request(makeApp()).post('/api/transactions').set('Authorization', authHeader('admin')).send({ type: 'http', config: { steps: [{ url: 'https://x/' }] } })).status, 400);
  assert.equal((await request(makeApp()).post('/api/transactions').set('Authorization', authHeader('admin')).send({ name: 'X', type: 'smtp', config: {} })).status, 400);
});

test('POST returns 400 for invalid per-type config', async () => {
  // http: no steps
  assert.equal((await request(makeApp()).post('/api/transactions').set('Authorization', authHeader('admin')).send({ name: 'A', type: 'http', config: { steps: [] } })).status, 400);
  // http: non-http URL
  assert.equal((await request(makeApp()).post('/api/transactions').set('Authorization', authHeader('admin')).send({ name: 'A', type: 'http', config: { steps: [{ url: 'ftp://x/' }] } })).status, 400);
  // tcp: bad port
  assert.equal((await request(makeApp()).post('/api/transactions').set('Authorization', authHeader('admin')).send({ name: 'A', type: 'tcp', config: { host: 'db', port: 99999 } })).status, 400);
  // dns: bad record type
  assert.equal((await request(makeApp()).post('/api/transactions').set('Authorization', authHeader('admin')).send({ name: 'A', type: 'dns', config: { host: 'db', record: 'ZZZ' } })).status, 400);
  // bad threshold
  assert.equal((await request(makeApp()).post('/api/transactions').set('Authorization', authHeader('admin')).send({ ...TCP_TEST, thresholds: { consecutive_fails: 0 } })).status, 400);
});

// ---- Results + heatmap ----

test('GET /:id/results — 404 unknown, 200 shape, 400 invalid from', async () => {
  const repo = makeTransactionsRepo({ results: async () => [{ id: 1, test_id: 1, agent_id: 2, status: 'ok', latency_ms: 210 }] });
  await repo.create({ ...HTTP_TEST });
  assert.equal((await request(app(repo)).get('/api/transactions/999/results').set('Authorization', authHeader('viewer'))).status, 404);
  const ok = await request(app(repo)).get('/api/transactions/1/results?agent_id=2').set('Authorization', authHeader('viewer'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.results.length, 1);
  assert.equal((await request(app(repo)).get('/api/transactions/1/results?from=not-a-date').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app(repo)).get('/api/transactions/1/results?agent_id=abc').set('Authorization', authHeader('viewer'))).status, 400);
});

test('GET /:id/heatmap — 404 unknown, 200 shape', async () => {
  const repo = makeTransactionsRepo({ heatmap: async () => [{ agent_id: 2, bucket: 100, avg_latency: 120, fail_count: 0, sample_count: 3 }] });
  await repo.create({ ...HTTP_TEST });
  assert.equal((await request(app(repo)).get('/api/transactions/999/heatmap').set('Authorization', authHeader('viewer'))).status, 404);
  const ok = await request(app(repo)).get('/api/transactions/1/heatmap?bucket=15m').set('Authorization', authHeader('viewer'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.bucket, '15m');
  assert.equal(ok.body.rows.length, 1);
  assert.equal(ok.body.rows[0].sample_count, 3);
});

// ---- 500 error handling ----

test('GET /api/transactions returns 500 on repo failure', async () => {
  const repo = makeTransactionsRepo({ list: throwingAsync() });
  const res = await request(app(repo)).get('/api/transactions').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

test('POST /api/transactions returns 500 on repo failure', async () => {
  const repo = makeTransactionsRepo({ create: throwingAsync() });
  const res = await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('admin')).send(HTTP_TEST);
  assert.equal(res.status, 500);
});
