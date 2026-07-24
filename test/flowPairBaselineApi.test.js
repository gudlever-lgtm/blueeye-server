'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeFlowPairBaselinesRepo, makeFlowsRepo, makeAgentsRepo, makeFindingStore, authHeader,
} = require('../test-support/fakes');
const { createFlowPairBaselineJob } = require('../src/analysis/flowPairBaselineJob');

const HOUR = 3600 * 1000;
const AGENTS = [
  { id: 1, hostname: 'web-1', capabilities: { ips: ['10.0.0.1'] } },
  { id: 2, hostname: 'db-1', capabilities: { ips: ['10.0.0.2'] } },
];
const agentsRepo = () => makeAgentsRepo({
  findAll: async () => AGENTS,
  findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null,
});
const JOB_CONFIG = { windowDays: 14, minObservations: 100, retentionDays: 21, intervalMinutes: 60, warnSigma: 3, critSigma: 4 };

// Seed 14 days of flat (~100B) hourly history for pair 1->2:443 ending before `bucketStart`.
async function seedHistory(repo, bucketStart) {
  const rows = [];
  for (let i = 1; i <= 336; i += 1) rows.push({ srcHostId: 1, dstHostId: 2, dstPort: 443, proto: 'tcp', bucket: new Date(bucketStart.getTime() - i * HOUR), bytes: 100, packets: 1, connCount: 1 });
  await repo.insertHourly(rows);
}

function jobHarness({ spikeBytes }) {
  const now = new Date('2026-06-15T12:30:00.000Z');
  const bucketEnd = new Date(Math.floor(now.getTime() / HOUR) * HOUR);
  const bucketStart = new Date(bucketEnd.getTime() - HOUR);
  const flowPairBaselinesRepo = makeFlowPairBaselinesRepo();
  const flowsRepo = makeFlowsRepo({
    tcpServiceFlows: async () => ([{ srcIp: '10.0.0.1', dstIp: '10.0.0.2', dstPort: 443, bytes: spikeBytes, packets: 10, connCount: 5, firstSeen: bucketStart, lastSeen: bucketEnd }]),
  });
  const findingStore = makeFindingStore();
  const job = createFlowPairBaselineJob({ flowPairBaselinesRepo, flowsRepo, agentsRepo: agentsRepo(), findingStore, config: JOB_CONFIG, now: () => now });
  return { job, flowPairBaselinesRepo, findingStore, bucketStart };
}

test('job scores a spike against the flat baseline and emits a finding to the store', async () => {
  const h = jobHarness({ spikeBytes: 100000 });
  await seedHistory(h.flowPairBaselinesRepo, h.bucketStart);
  const res = await h.job.run();
  assert.ok(res && res.flagged >= 1, `expected a flagged deviation, got ${JSON.stringify(res)}`);

  assert.equal(h.findingStore.rows.length, 1);
  const f = h.findingStore.rows[0];
  assert.equal(f.metric, 'flow.volume');
  assert.equal(f.kind, 'ANOMALY');
  assert.equal(f.hostId, '1');                 // src host key
  assert.equal(f.severity, 'CRIT');
  assert.equal(f.observed, 100000);
  assert.ok(Array.isArray(f.evidence) && f.evidence[0].labels.dst === '2' && f.evidence[0].labels.dstPort === 443);
  assert.ok(f.explanation && f.explanation.length > 0);
});

test('job emits nothing when the current volume matches the baseline (no deviation)', async () => {
  const h = jobHarness({ spikeBytes: 100 }); // same as the flat history
  await seedHistory(h.flowPairBaselinesRepo, h.bucketStart);
  const res = await h.job.run();
  assert.equal(res.flagged, 0);
  assert.equal(h.findingStore.rows.length, 0);
});

test('job scores nothing until the pair passes the minimum observation gate', async () => {
  const h = jobHarness({ spikeBytes: 100000 });
  // Only 10 buckets of history (< 100) → gated, no baseline, no score.
  const rows = [];
  for (let i = 1; i <= 10; i += 1) rows.push({ srcHostId: 1, dstHostId: 2, dstPort: 443, proto: 'tcp', bucket: new Date(h.bucketStart.getTime() - i * HOUR), bytes: 100, packets: 1, connCount: 1 });
  await h.flowPairBaselinesRepo.insertHourly(rows);
  const res = await h.job.run();
  assert.equal(res.flagged, 0);
  assert.equal(h.findingStore.rows.length, 0);
});

// ---- API (operator+; 400/401/403/404/500) ------------------------------------

async function seededRepo() {
  const repo = makeFlowPairBaselinesRepo();
  await repo.upsertBaselines([{ srcHostId: 1, dstHostId: 2, dstPort: 443, dow: 2, hour: 14, medianBytes: 100, madBytes: 10, sampleCount: 4, observationCount: 336 }]);
  return repo;
}

test('GET /api/topology/flow-baselines?host= returns baselines (operator+)', async () => {
  const app = makeApp({ flowPairBaselinesRepo: await seededRepo(), agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/flow-baselines?host=1').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.host, 1);
  assert.equal(res.body.baselines.length, 1);
  assert.equal(res.body.baselines[0].dstPort, 443);
});

test('GET /api/topology/flow-baselines requires auth → 401', async () => {
  const app = makeApp({ flowPairBaselinesRepo: await seededRepo(), agentsRepo: agentsRepo() });
  assert.equal((await request(app).get('/api/topology/flow-baselines?host=1')).status, 401);
});

test('GET /api/topology/flow-baselines enforces role → 403 for viewer', async () => {
  const app = makeApp({ flowPairBaselinesRepo: await seededRepo(), agentsRepo: agentsRepo() });
  assert.equal((await request(app).get('/api/topology/flow-baselines?host=1').set('Authorization', authHeader('viewer'))).status, 403);
});

test('GET /api/topology/flow-baselines unknown host → 404', async () => {
  const app = makeApp({ flowPairBaselinesRepo: await seededRepo(), agentsRepo: agentsRepo() });
  assert.equal((await request(app).get('/api/topology/flow-baselines?host=999').set('Authorization', authHeader('operator'))).status, 404);
});

test('GET /api/topology/flow-baselines without host → 400', async () => {
  const app = makeApp({ flowPairBaselinesRepo: await seededRepo(), agentsRepo: agentsRepo() });
  assert.equal((await request(app).get('/api/topology/flow-baselines').set('Authorization', authHeader('operator'))).status, 400);
});

test('GET /api/topology/flow-baselines → 500 on store failure', async () => {
  const flowPairBaselinesRepo = makeFlowPairBaselinesRepo({ listForHost: async () => { throw new Error('DB down'); } });
  const app = makeApp({ flowPairBaselinesRepo, agentsRepo: agentsRepo() });
  assert.equal((await request(app).get('/api/topology/flow-baselines?host=1').set('Authorization', authHeader('operator'))).status, 500);
});
