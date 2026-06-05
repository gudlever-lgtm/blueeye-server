'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentTokensRepo,
  makeAgentsRepo,
  makeAgentCommander,
  makeSpeedtestResultsRepo,
  authHeader,
} = require('../test-support/fakes');
const { validateTestPackageInput } = require('../src/validation/testPackageValidation');
const { itemToCommand } = require('../src/services/testPackageRunner');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

// ---- bandwidth endpoints (agent token) -------------------------------------

test('GET /speedtest/download streams the requested number of bytes', async () => {
  const res = await request(makeApp({ agentTokensRepo: agentToken() }))
    .get('/speedtest/download?bytes=4096')
    .set('Authorization', 'Bearer good')
    .buffer(true)
    .parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-length'], '4096');
  assert.equal(res.body.length, 4096);
});

test('GET /speedtest/download requires an agent token (401)', async () => {
  const res = await request(makeApp({ agentTokensRepo: makeAgentTokensRepo({ findActiveByHash: async () => null }) }))
    .get('/speedtest/download?bytes=1024')
    .set('Authorization', 'Bearer nope');
  assert.equal(res.status, 401);
});

test('POST /speedtest/upload counts the uploaded bytes', async () => {
  const res = await request(makeApp({ agentTokensRepo: agentToken() }))
    .post('/speedtest/upload')
    .set('Authorization', 'Bearer good')
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.alloc(5000, 0));
  assert.equal(res.status, 200);
  assert.equal(res.body.bytes, 5000);
});

// ---- result submit (agent token) -------------------------------------------

test('POST /speedtest/results stores a measurement (201)', async () => {
  const repo = makeSpeedtestResultsRepo();
  const res = await request(makeApp({ agentTokensRepo: agentToken(), speedtestResultsRepo: repo }))
    .post('/speedtest/results')
    .set('Authorization', 'Bearer good')
    .send({ result: { ok: true, downMbps: 120.5, upMbps: 40, downBytes: 1000, upBytes: 1000, downMs: 66, upMs: 200, target: 'srv' } });
  assert.equal(res.status, 201);
  assert.equal(repo.rows.length, 1);
  assert.equal(repo.rows[0].agentId, 9);
  assert.equal(repo.rows[0].downMbps, 120.5);
});

test('POST /speedtest/results rejects a missing result (400)', async () => {
  const res = await request(makeApp({ agentTokensRepo: agentToken() }))
    .post('/speedtest/results')
    .set('Authorization', 'Bearer good')
    .send({});
  assert.equal(res.status, 400);
});

test('POST /speedtest/results rejects a negative number (400)', async () => {
  const res = await request(makeApp({ agentTokensRepo: agentToken() }))
    .post('/speedtest/results')
    .set('Authorization', 'Bearer good')
    .send({ result: { downMbps: -1 } });
  assert.equal(res.status, 400);
});

// ---- read endpoint (user JWT) ----------------------------------------------

test('GET /api/speedtest returns an agent\'s results (viewer+)', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9 }) });
  const repo = makeSpeedtestResultsRepo({ findByAgent: async () => [{ id: 1, ts: '2026-01-01T00:00:00Z', down_mbps: 100, up_mbps: 20, ok: 1 }] });
  const res = await request(makeApp({ agentsRepo, speedtestResultsRepo: repo }))
    .get('/api/speedtest?agentId=9')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].down_mbps, 100);
});

test('GET /api/speedtest requires agentId (400)', async () => {
  const res = await request(makeApp()).get('/api/speedtest').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/speedtest 404 for an unknown agent', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const res = await request(makeApp({ agentsRepo })).get('/api/speedtest?agentId=999').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

// ---- on-demand trigger (POST /agents/:id/run-speedtest) --------------------

test('POST /agents/:id/run-speedtest pushes a speedtest command (operator) -> 202', async () => {
  let sent;
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9 }) });
  const agentCommander = makeAgentCommander({ sendCommand: (id, cmd) => { sent = { id, cmd }; return 1; } });
  const res = await request(makeApp({ agentsRepo, agentCommander }))
    .post('/agents/9/run-speedtest')
    .set('Authorization', authHeader('operator'));
  assert.equal(res.status, 202);
  assert.equal(sent.cmd.name, 'speedtest');
});

test('POST /agents/:id/run-speedtest returns 409 when not connected', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9 }) });
  const agentCommander = makeAgentCommander({ sendCommand: () => 0 });
  const res = await request(makeApp({ agentsRepo, agentCommander }))
    .post('/agents/9/run-speedtest')
    .set('Authorization', authHeader('operator'));
  assert.equal(res.status, 409);
});

test('POST /agents/:id/run-speedtest is forbidden for a viewer (403)', async () => {
  const res = await request(makeApp()).post('/agents/9/run-speedtest').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

// ---- test-package integration ----------------------------------------------

test('a speedtest item is accepted in a package and maps to a speedtest command', () => {
  const { value, errors } = validateTestPackageInput({ name: 'p', targets: { mode: 'all' }, items: [{ type: 'speedtest' }] });
  assert.equal(errors, undefined);
  assert.equal(value.items[0].type, 'speedtest');
  assert.deepEqual(itemToCommand(value.items[0]), { name: 'speedtest' });
  assert.deepEqual(itemToCommand({ type: 'speedtest', bytes: 2048 }), { name: 'speedtest', bytes: 2048 });
});

test('a speedtest item with out-of-range bytes is rejected', () => {
  const { errors } = validateTestPackageInput({ name: 'p', targets: { mode: 'all' }, items: [{ type: 'speedtest', bytes: 10 }] });
  assert.ok(errors && errors.items);
});
