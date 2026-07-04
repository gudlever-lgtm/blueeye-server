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
  config: {
    steps: [
      { name: 'Home', method: 'GET', url: 'https://example.com/', expect_status: 200 },
      { name: 'Login', method: 'POST', url: 'https://example.com/login', headers: { Authorization: 'Bearer {{secret:API_KEY}}' }, body: '{}', expect_status: 200, expect_keyword: 'token', extract: { name: 'TOKEN', type: 'json', pattern: 'token' } },
    ],
    thresholds: { consecutive_fails: 3, latency_ms: 2000, deviation: 'slower' },
  },
  secrets: { API_KEY: 'supersecret-value-123' },
};
const TCP_TEST = { name: 'DB reachability', type: 'tcp', target: 'db.internal', config: { port: 5432 } };
const DNS_TEST = { name: 'Resolve site', type: 'dns', target: 'example.com', config: { record: 'A' } };
const ICMP_TEST = { name: 'Ping GW', type: 'icmp', target: '8.8.8.8', config: {} };

const app = (repo) => makeApp(repo ? { transactionsRepo: repo } : {});
const bad = async (body) => (await request(makeApp()).post('/api/transactions').set('Authorization', authHeader('admin')).send(body)).status;

// ---- Auth / RBAC ----

test('GET /api/transactions requires auth (401)', async () => {
  assert.equal((await request(makeApp()).get('/api/transactions')).status, 401);
});

test('POST is 403 for viewer/operator, 201 for admin', async () => {
  const repo = makeTransactionsRepo();
  assert.equal((await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('viewer')).send(HTTP_TEST)).status, 403);
  assert.equal((await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('operator')).send(HTTP_TEST)).status, 403);
  const a = await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('admin')).send(HTTP_TEST);
  assert.equal(a.status, 201);
  assert.equal(a.body.type, 'http');
  assert.equal(a.body.config.steps.length, 2);
});

test('POST accepts tcp, dns and icmp', async () => {
  const repo = makeTransactionsRepo();
  for (const body of [TCP_TEST, DNS_TEST, ICMP_TEST]) {
    const r = await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('admin')).send(body);
    assert.equal(r.status, 201, `${body.type} should be accepted`);
    assert.equal(r.body.type, body.type);
    assert.equal(r.body.target, body.target);
  }
});

// ---- Secrets never leak ----

test('secrets are write-only: response exposes names, never values', async () => {
  const repo = makeTransactionsRepo();
  const created = await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('admin')).send(HTTP_TEST);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.secret_names, ['API_KEY']);
  assert.equal(created.body.secrets, undefined);
  assert.ok(!JSON.stringify(created.body).includes('supersecret-value-123'), 'secret value must not appear in create response');
  // GET :id
  const one = await request(app(repo)).get('/api/transactions/1').set('Authorization', authHeader('viewer'));
  assert.ok(!JSON.stringify(one.body).includes('supersecret-value-123'), 'secret value must not appear in GET :id');
  assert.equal(one.body.secrets, undefined);
  // list
  const list = await request(app(repo)).get('/api/transactions').set('Authorization', authHeader('viewer'));
  assert.ok(!JSON.stringify(list.body).includes('supersecret-value-123'), 'secret value must not appear in list');
});

// ---- CRUD ----

test('GET list empty; GET :id 400/404/200', async () => {
  const repo = makeTransactionsRepo();
  assert.deepEqual((await request(app(repo)).get('/api/transactions').set('Authorization', authHeader('viewer'))).body, []);
  await repo.create({ ...TCP_TEST });
  assert.equal((await request(app(repo)).get('/api/transactions/abc').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app(repo)).get('/api/transactions/9999').set('Authorization', authHeader('viewer'))).status, 404);
  assert.equal((await request(app(repo)).get('/api/transactions/1').set('Authorization', authHeader('viewer'))).status, 200);
});

test('PUT updates (admin); 404 unknown; 403 viewer', async () => {
  const repo = makeTransactionsRepo();
  await repo.create({ ...TCP_TEST });
  const upd = await request(app(repo)).put('/api/transactions/1').set('Authorization', authHeader('admin')).send({ ...TCP_TEST, name: 'Renamed' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Renamed');
  assert.equal((await request(app(repo)).put('/api/transactions/999').set('Authorization', authHeader('admin')).send(TCP_TEST)).status, 404);
  assert.equal((await request(app(repo)).put('/api/transactions/1').set('Authorization', authHeader('viewer')).send(TCP_TEST)).status, 403);
});

test('DELETE removes (admin); 404 missing; 403 viewer', async () => {
  const repo = makeTransactionsRepo();
  await repo.create({ ...TCP_TEST });
  assert.equal((await request(app(repo)).delete('/api/transactions/1').set('Authorization', authHeader('viewer'))).status, 403);
  assert.equal((await request(app(repo)).delete('/api/transactions/1').set('Authorization', authHeader('admin'))).status, 204);
  assert.equal((await request(app(repo)).delete('/api/transactions/999').set('Authorization', authHeader('admin'))).status, 404);
});

// ---- Agent assignment ----

test('PUT /:id/agents assigns (admin, de-duped); 404/400/403', async () => {
  const repo = makeTransactionsRepo();
  await repo.create({ ...TCP_TEST });
  const res = await request(app(repo)).put('/api/transactions/1/agents').set('Authorization', authHeader('admin')).send({ agent_ids: [3, 7, 7] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.agent_ids, [3, 7]);
  assert.equal((await request(app(repo)).put('/api/transactions/999/agents').set('Authorization', authHeader('admin')).send({ agent_ids: [1] })).status, 404);
  assert.equal((await request(app(repo)).put('/api/transactions/1/agents').set('Authorization', authHeader('admin')).send({ agent_ids: 'x' })).status, 400);
  assert.equal((await request(app(repo)).put('/api/transactions/1/agents').set('Authorization', authHeader('viewer')).send({ agent_ids: [1] })).status, 403);
});

// ---- Validation (400) ----

test('POST 400 for missing name / unknown type', async () => {
  assert.equal(await bad({ type: 'http', config: { steps: [{ url: 'https://x/' }] } }), 400);
  assert.equal(await bad({ name: 'X', type: 'smtp', config: {} }), 400);
});

test('POST 400 for invalid per-type config', async () => {
  assert.equal(await bad({ name: 'A', type: 'http', config: { steps: [] } }), 400);
  assert.equal(await bad({ name: 'A', type: 'http', config: { steps: [{ url: 'ftp://x/' }] } }), 400);
  assert.equal(await bad({ name: 'A', type: 'tcp', target: 'db', config: { port: 99999 } }), 400);
  assert.equal(await bad({ name: 'A', type: 'tcp', config: { port: 22 } }), 400); // missing target
  assert.equal(await bad({ name: 'A', type: 'dns', target: 'db', config: { record: 'ZZZ' } }), 400);
  assert.equal(await bad({ name: 'A', type: 'icmp', target: '-rf' }), 400); // bad host
  assert.equal(await bad({ ...TCP_TEST, config: { port: 5432, thresholds: { consecutive_fails: 0 } } }), 400);
});

test('POST 400 for a reference to an undeclared secret', async () => {
  const body = { name: 'A', type: 'http', config: { steps: [{ url: 'https://x/', headers: { Authorization: 'Bearer {{secret:MISSING}}' } }] } };
  assert.equal(await bad(body), 400);
  // declaring it makes it valid
  assert.equal(await bad({ ...body, secrets: { MISSING: 'v' } }), 201);
});

// ---- Results / heatmap / trend ----

test('GET /:id/results — 404, 200, 400 (bad from / agent_id)', async () => {
  const repo = makeTransactionsRepo({ results: async () => [{ time: 't', test_id: 1, agent_id: 2, status: 'ok', latency_ms: 210 }] });
  await repo.create({ ...TCP_TEST });
  assert.equal((await request(app(repo)).get('/api/transactions/999/results').set('Authorization', authHeader('viewer'))).status, 404);
  const ok = await request(app(repo)).get('/api/transactions/1/results?agent_id=2').set('Authorization', authHeader('viewer'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.results.length, 1);
  assert.equal((await request(app(repo)).get('/api/transactions/1/results?from=nope').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app(repo)).get('/api/transactions/1/results?agent_id=abc').set('Authorization', authHeader('viewer'))).status, 400);
});

test('GET /:id/heatmap — 404, 200 shape', async () => {
  const repo = makeTransactionsRepo({ heatmap: async () => [{ agent_id: 2, bucket: 100, avg_latency: 120, fail_count: 0, sample_count: 3 }] });
  await repo.create({ ...TCP_TEST });
  assert.equal((await request(app(repo)).get('/api/transactions/999/heatmap').set('Authorization', authHeader('viewer'))).status, 404);
  const ok = await request(app(repo)).get('/api/transactions/1/heatmap?bucket=15m').set('Authorization', authHeader('viewer'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.bucket, '15m');
  assert.equal(ok.body.rows[0].sample_count, 3);
});

test('GET /:id/trend — 404, 400 (no agent_id), 200', async () => {
  const repo = makeTransactionsRepo({ trend: async () => [{ day: '2026-07-01', step: 0, median_ms: 200, sample_count: 5 }] });
  await repo.create({ ...HTTP_TEST });
  assert.equal((await request(app(repo)).get('/api/transactions/999/trend?agent_id=2').set('Authorization', authHeader('viewer'))).status, 404);
  assert.equal((await request(app(repo)).get('/api/transactions/1/trend').set('Authorization', authHeader('viewer'))).status, 400);
  const ok = await request(app(repo)).get('/api/transactions/1/trend?agent_id=2&days=7').set('Authorization', authHeader('viewer'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rows.length, 1);
});

// ---- 500 ----

test('GET list 500 on repo failure', async () => {
  const repo = makeTransactionsRepo({ list: throwingAsync() });
  assert.equal((await request(app(repo)).get('/api/transactions').set('Authorization', authHeader('viewer'))).status, 500);
});

test('POST 500 on repo failure', async () => {
  const repo = makeTransactionsRepo({ create: throwingAsync() });
  assert.equal((await request(app(repo)).post('/api/transactions').set('Authorization', authHeader('admin')).send(TCP_TEST)).status, 500);
});
