'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFindingStore, makeAnalysisPipeline, makeAgentTokensRepo, authHeader } = require('../test-support/fakes');
const { createAnalysisPipeline } = require('../src/analysis/pipeline');
const { createDetector } = require('../src/analysis/detector');
const { createBaselineStore, MAD_TO_SIGMA } = require('../src/analysis/baselines');
const { loadConfig } = require('../src/analysis/config');

const viewer = () => authHeader('viewer');
const operator = () => authHeader('operator');
const agentTok = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

// ---- GET /api/findings -----------------------------------------------------
test('GET /api/findings returns 200 + array', async () => {
  const findingStore = makeFindingStore();
  findingStore.rows.push({ id: 'f1', hostId: '9', metric: 'cpu', explanation: 'x', evidence: [{}], createdAt: new Date() });
  const res = await request(makeApp({ findingStore })).get('/api/findings').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 1);
});

test('GET /api/findings filters by hostId', async () => {
  const findingStore = makeFindingStore();
  findingStore.rows.push({ id: 'a', hostId: '9', createdAt: new Date() }, { id: 'b', hostId: '7', createdAt: new Date() });
  const res = await request(makeApp({ findingStore })).get('/api/findings?hostId=9').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].hostId, '9');
});

test('GET /api/findings returns 400 for an invalid since', async () => {
  const res = await request(makeApp()).get('/api/findings?since=not-a-date').set('Authorization', viewer());
  assert.equal(res.status, 400);
});

test('GET /api/findings without a token returns 401', async () => {
  const res = await request(makeApp()).get('/api/findings');
  assert.equal(res.status, 401);
});

// ---- POST /api/findings/:id/ack -------------------------------------------
test('POST ack on an unknown id returns 404', async () => {
  const findingStore = makeFindingStore({ ack: async () => false });
  const res = await request(makeApp({ findingStore })).post('/api/findings/nope/ack').set('Authorization', operator());
  assert.equal(res.status, 404);
});

test('POST ack on a known id returns 200 and the finding is acked', async () => {
  const findingStore = makeFindingStore();
  findingStore.rows.push({ id: 'f1', hostId: '9', acked: false });
  const res = await request(makeApp({ findingStore })).post('/api/findings/f1/ack').set('Authorization', operator());
  assert.equal(res.status, 200);
  assert.equal(res.body.acked, true);
  assert.equal(findingStore.rows[0].acked, true);
});

test('POST ack as a viewer returns 403', async () => {
  const res = await request(makeApp()).post('/api/findings/f1/ack').set('Authorization', viewer());
  assert.equal(res.status, 403);
});

// ---- ingest integration ----------------------------------------------------
test('ingest with analysisEnabled=false produces no findings', async () => {
  // A pipeline built with the flag off should yield nothing even on an anomaly.
  const findingStore = makeFindingStore();
  const baselines = createBaselineStore({ minSamples: 5, windowSize: 200 });
  const ts = new Date('2026-01-01T03:00:00Z');
  for (let i = 0; i < 10; i += 1) baselines.update({ hostId: '9', metric: 'cpu', value: 10 + (i % 2), ts });
  const detector = createDetector({ baselines, config: { ...loadConfig({}), minSamples: 5 } });
  const pipeline = createAnalysisPipeline({
    detector, findingStore,
    config: { ...loadConfig({}), analysisEnabled: false },
  });

  const app = makeApp({ agentTokensRepo: agentTok(), analysisPipeline: pipeline });
  const res = await request(app).post('/agents/results').set('Authorization', 'Bearer t')
    .send({ results: [{ name: 'm', system: { cpuPercent: 9999, memUsedPercent: 50 }, traffic: { totals: { rxBytesPerSec: 0, txBytesPerSec: 0 } } }] });

  assert.equal(res.status, 201);
  assert.equal(findingStore.rows.length, 0); // flag off -> nothing produced
});

test('ingest with analysis enabled saves + publishes a finding on an anomaly', async () => {
  const findingStore = makeFindingStore();
  const published = [];
  const baselines = createBaselineStore({ minSamples: 5, windowSize: 200 });
  const ts = new Date(); // current bucket so the ingested sample matches
  for (let i = 0; i < 10; i += 1) baselines.update({ hostId: '9', metric: 'cpu', value: 10 + (i % 2 ? -1 : 1), ts });
  const detector = createDetector({ baselines, config: { ...loadConfig({}), minSamples: 5 } });
  const pipeline = createAnalysisPipeline({
    detector, findingStore,
    config: { ...loadConfig({}), analysisEnabled: true },
    publishFinding: (hostId, msg) => published.push({ hostId, msg }),
  });

  const app = makeApp({ agentTokensRepo: agentTok(), analysisPipeline: pipeline });
  const cpu = 10 + 6 * MAD_TO_SIGMA; // ~6σ -> CRIT
  const res = await request(app).post('/agents/results').set('Authorization', 'Bearer t')
    .send({ results: [{ name: 'm', system: { cpuPercent: cpu, memUsedPercent: 50 } }] });

  assert.equal(res.status, 201);
  const cpuFindings = findingStore.rows.filter((f) => f.metric === 'cpu');
  assert.ok(cpuFindings.length >= 1, 'expected a cpu finding');
  assert.ok(published.some((p) => p.msg.type === 'finding'), 'expected a published finding event');
});

test('ingest still succeeds (no 500) when the analysis pipeline throws', async () => {
  const analysisPipeline = makeAnalysisPipeline({ processResults: async () => { throw new Error('boom'); } });
  const app = makeApp({ agentTokensRepo: agentTok(), analysisPipeline });
  const res = await request(app).post('/agents/results').set('Authorization', 'Bearer t')
    .send({ results: [{ name: 'm' }] });
  assert.equal(res.status, 201); // analysis is best-effort; ingest already persisted
});
