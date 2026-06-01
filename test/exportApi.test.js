'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFindingStore, makeFlowsRepo, makeAgentsRepo, makeLocationsRepo, makeResultsRepo, makeFeatureGate, authHeader } = require('../test-support/fakes');

const viewer = () => authHeader('viewer');

function findingStoreWith(rows) {
  const fs = makeFindingStore();
  rows.forEach((r) => fs.rows.push(r));
  return fs;
}

// ---- findings --------------------------------------------------------------
test('GET /api/export/findings?format=csv returns CSV with a header + rows', async () => {
  const findingStore = findingStoreWith([
    { id: 'f1', createdAt: new Date('2026-01-01T00:00:00Z'), hostId: '9', metric: 'cpu', severity: 'CRIT', kind: 'ANOMALY', deviation: 5, explanation: 'cpu high', correlatedWith: ['f2'], acked: false, evidence: [{}] },
  ]);
  const res = await request(makeApp({ findingStore })).get('/api/export/findings?format=csv').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment; filename="blueeye-findings\.csv"/);
  const lines = res.text.trim().split('\n');
  assert.equal(lines[0], 'id,createdAt,hostId,metric,severity,kind,observed,baseline,deviation,explanation,correlatedWith,acked');
  assert.match(lines[1], /^f1,2026-01-01T00:00:00\.000Z,9,cpu,CRIT,ANOMALY,,,5,cpu high,f2,false$/);
});

test('GET /api/export/findings defaults to JSON (array of objects)', async () => {
  const findingStore = findingStoreWith([{ id: 'f1', hostId: '9', metric: 'cpu', explanation: 'x', createdAt: new Date() }]);
  const res = await request(makeApp({ findingStore })).get('/api/export/findings').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body[0].metric, 'cpu');
});

test('CSV escapes commas and quotes in fields', async () => {
  const findingStore = findingStoreWith([{ id: 'f1', hostId: '9', metric: 'cpu', explanation: 'spike, very "high"', createdAt: new Date('2026-01-01T00:00:00Z') }]);
  const res = await request(makeApp({ findingStore })).get('/api/export/findings?format=csv').set('Authorization', viewer());
  assert.match(res.text, /"spike, very ""high"""/);
});

// ---- agents / locations ----------------------------------------------------
test('GET /api/export/agents?format=csv exports the agent inventory', async () => {
  const agentsRepo = makeAgentsRepo({ findAll: async () => [{ id: 1, hostname: 'h1', display_name: 'HQ', platform: 'linux', arch: 'x64', status: 'online', location_name: 'Office', last_report_at: null }] });
  const res = await request(makeApp({ agentsRepo })).get('/api/export/agents?format=csv').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.match(res.text, /^id,hostname,display_name,platform,arch,status,location_name,last_report_at/);
  assert.match(res.text, /1,h1,HQ,linux,x64,online,Office,/);
});

test('GET /api/export/locations returns JSON', async () => {
  const locationsRepo = makeLocationsRepo({ findAll: async () => [{ id: 2, name: 'DC', address: 'A', latitude: 55.6, longitude: 12.5 }] });
  const res = await request(makeApp({ locationsRepo })).get('/api/export/locations').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body[0].name, 'DC');
});

// ---- geo (license-gated) ---------------------------------------------------
test('GET /api/export/geo exports aggregated destinations', async () => {
  const flowsRepo = makeFlowsRepo({ aggregateExternalDestinations: async () => [{ country: 'DE', asn: 3320, asnName: 'DTAG', bytes: 100, flowCount: 5, deviation: 0.5 }] });
  const res = await request(makeApp({ flowsRepo })).get('/api/export/geo?format=csv').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.match(res.text, /^country,asn,asnName,bytes,flowCount,deviation/);
  assert.match(res.text, /DE,3320,DTAG,100,5,0\.5/);
});

test('GET /api/export/geo returns 403 when geo is not licensed', async () => {
  const featureGate = makeFeatureGate({ features: { geo: false, analysis: true, assistant: true, alerting: true } });
  const res = await request(makeApp({ featureGate })).get('/api/export/geo').set('Authorization', viewer());
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'license');
});

// ---- traffic ---------------------------------------------------------------
test('GET /api/export/traffic requires an agentId (400) and exports rows otherwise', async () => {
  const resultsRepo = makeResultsRepo({ findByAgentId: async () => [{ agent_id: 9, created_at: new Date('2026-01-01T00:00:00Z'), payload: { system: { cpuPercent: 42, memUsedPercent: 70, loadavg: [1.5] }, traffic: { totals: { rxBytesPerSec: 100, txBytesPerSec: 200 } } } }] });
  const app = makeApp({ resultsRepo });
  assert.equal((await request(app).get('/api/export/traffic').set('Authorization', viewer())).status, 400);
  const res = await request(app).get('/api/export/traffic?agentId=9&format=csv').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.match(res.text, /9,2026-01-01T00:00:00\.000Z,42,70,1\.5,100,200/);
});

// ---- error / edge paths ----------------------------------------------------
test('an unknown resource returns 404', async () => {
  const res = await request(makeApp()).get('/api/export/nope').set('Authorization', viewer());
  assert.equal(res.status, 404);
});

test('export without a token returns 401', async () => {
  assert.equal((await request(makeApp()).get('/api/export/findings')).status, 401);
});

test('an invalid since returns 400', async () => {
  const res = await request(makeApp()).get('/api/export/findings?since=not-a-date').set('Authorization', viewer());
  assert.equal(res.status, 400);
});

test('a repository failure surfaces as 500', async () => {
  const findingStore = makeFindingStore({ list: async () => { throw new Error('db down'); } });
  const res = await request(makeApp({ findingStore })).get('/api/export/findings').set('Authorization', viewer());
  assert.equal(res.status, 500);
});
