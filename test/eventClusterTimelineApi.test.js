'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeEventClustersRepo, makeFindingStore, makeConfigSnapshotsRepo,
  makeAuditEventsRepo, makeRemediationPlaybooksRepo, authHeader,
} = require('../test-support/fakes');

const ONSET = new Date('2026-07-01T12:00:00Z');
const rel = (ms) => new Date(ONSET.getTime() + ms);

// Seeds a cluster with two member findings on agents 1 & 2, plus a pre-event
// config change and a pre-event agent disconnect. Returns { app, id, repos }.
async function withClusterTimeline(over = {}) {
  const eventClustersRepo = over.eventClustersRepo || makeEventClustersRepo();
  const findingStore = makeFindingStore();
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  const auditEventsRepo = makeAuditEventsRepo();
  const remediationPlaybooksRepo = makeRemediationPlaybooksRepo();

  findingStore.rows.push({ id: 'a', hostId: '1', metric: 'probe.loss', severity: 'CRIT', explanation: 'loss', evidence: [{}], createdAt: ONSET, acked: false });
  findingStore.rows.push({ id: 'b', hostId: '2', metric: 'probe.loss', severity: 'WARN', explanation: 'loss', evidence: [{}], createdAt: rel(60000), acked: false });

  // Pre-event change (10 min before onset) on agent 1.
  await configSnapshotsRepo.insert({ deviceId: 1, configText: 'x', capturedVia: 'change_detected', capturedAt: rel(-10 * 60 * 1000) });
  // Pre-event agent disconnect (2 min before onset) — actor_id numeric.
  auditEventsRepo.rows.push({ id: 99, actorType: 'agent', actorId: 1, action: 'agent.offline', ts: rel(-2 * 60 * 1000).toISOString(), targetType: null, targetId: null, ip: null, detail: null });

  const id = await eventClustersRepo.create({
    confidence: 'high', memberFindingIds: ['a', 'b'], suspectedCommonCause: 'shared uplink',
    status: 'open', detectedAt: rel(60000),
  });
  const app = makeApp({ eventClustersRepo, findingStore, configSnapshotsRepo, auditEventsRepo, remediationPlaybooksRepo, ...over.appOverrides });
  return { app, id, eventClustersRepo, findingStore };
}

test('GET /:id/timeline returns a merged stream + what-changed (viewer+) → 200', async () => {
  const { app, id } = await withClusterTimeline();
  const res = await request(app).get(`/api/event-clusters/${id}/timeline`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.clusterId, id);
  // member findings present
  assert.ok(res.body.events.some((e) => e.source === 'finding' && e.ref_id === 'a'));
  // what-changed holds the pre-event config change + agent disconnect, not the findings
  const changedSources = res.body.whatChanged.map((e) => e.source).sort();
  assert.deepEqual([...new Set(changedSources)], ['agent', 'config']);
  assert.ok(res.body.whatChanged.every((e) => e.source !== 'finding'));
  assert.equal(res.body.window.lookbackMinutes, 30);
  assert.deepEqual(res.body.affectedAgents.sort(), ['1', '2']);
});

test('GET /:id/timeline honours a custom lookback (shrinks the what-changed window)', async () => {
  const { app, id } = await withClusterTimeline();
  // 5-min lookback excludes the 10-min-old config change but keeps the 2-min disconnect.
  const res = await request(app).get(`/api/event-clusters/${id}/timeline?lookback=5`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.window.lookbackMinutes, 5);
  assert.deepEqual([...new Set(res.body.whatChanged.map((e) => e.source))], ['agent']);
});

test('GET /:id/timeline rejects a bad lookback → 400', async () => {
  const { app, id } = await withClusterTimeline();
  for (const bad of ['0', '-5', 'abc', '99999']) {
    const res = await request(app).get(`/api/event-clusters/${id}/timeline?lookback=${bad}`).set('Authorization', authHeader('viewer'));
    assert.equal(res.status, 400, `lookback=${bad} should be 400`);
  }
});

test('GET /:id/timeline requires auth → 401', async () => {
  const { app, id } = await withClusterTimeline();
  assert.equal((await request(app).get(`/api/event-clusters/${id}/timeline`)).status, 401);
});

test('GET /:id/timeline is 404 for an unknown cluster', async () => {
  const { app } = await withClusterTimeline();
  const res = await request(app).get('/api/event-clusters/99999/timeline').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /:id/timeline is 400 for a non-numeric id', async () => {
  const { app } = await withClusterTimeline();
  const res = await request(app).get('/api/event-clusters/abc/timeline').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /:id/timeline: one failed source degrades to partial, not 500', async () => {
  const eventClustersRepo = makeEventClustersRepo();
  const findingStore = makeFindingStore();
  findingStore.rows.push({ id: 'a', hostId: '1', metric: 'probe.loss', severity: 'CRIT', explanation: 'x', evidence: [{}], createdAt: ONSET, acked: false });
  const id = await eventClustersRepo.create({ confidence: 'high', memberFindingIds: ['a'], status: 'open', detectedAt: ONSET });
  // configSnapshots source throws → should surface as partial, not a 500.
  const configSnapshotsRepo = makeConfigSnapshotsRepo({ listForDeviceBetween: async () => { throw new Error('db down'); } });
  const app = makeApp({ eventClustersRepo, findingStore, configSnapshotsRepo });

  const res = await request(app).get(`/api/event-clusters/${id}/timeline`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.partial, true);
  assert.ok(res.body.failedSources.includes('configChanges'));
});

test('GET /:id/timeline returns a clean 500 when the cluster lookup itself throws', async () => {
  const eventClustersRepo = makeEventClustersRepo({ findById: async () => { throw new Error('cluster table exploded'); } });
  const app = makeApp({ eventClustersRepo });
  const res = await request(app).get('/api/event-clusters/1/timeline').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!/exploded/.test(String(res.body.error)));
});
