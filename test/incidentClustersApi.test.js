'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeIncidentClustersRepo, makeFindingStore, authHeader } = require('../test-support/fakes');

// Seeds a repo + finding store with one open cluster and returns everything the
// tests need. `members` are pushed into the finding store so GET /:id can hydrate.
async function withCluster(over = {}) {
  const incidentClustersRepo = over.incidentClustersRepo || makeIncidentClustersRepo();
  const findingStore = over.findingStore || makeFindingStore();
  const members = over.members || [
    { id: 'a', hostId: '1', metric: 'probe.loss', severity: 'CRIT', kind: 'THRESHOLD', explanation: 'loss', evidence: [{}], createdAt: new Date('2026-07-01T12:00:00Z'), acked: false },
    { id: 'b', hostId: '2', metric: 'probe.loss', severity: 'WARN', kind: 'THRESHOLD', explanation: 'loss', evidence: [{}], createdAt: new Date('2026-07-01T12:01:00Z'), acked: false },
  ];
  for (const m of members) findingStore.rows.push(m);
  const id = await incidentClustersRepo.create({
    confidence: 'high', memberFindingIds: members.map((m) => m.id),
    suspectedCommonCause: 'shared uplink', status: over.status || 'open',
    detectedAt: new Date('2026-07-01T12:01:00Z'),
  });
  const app = makeApp({ incidentClustersRepo, findingStore });
  return { app, incidentClustersRepo, findingStore, id, members };
}

// ---- GET /api/incident-clusters -------------------------------------------

test('GET list returns clusters + pagination (viewer+) → 200', async () => {
  const { app } = await withCluster();
  const res = await request(app).get('/api/incident-clusters').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.clusters.length, 1);
  assert.equal(res.body.page.total, 1);
  assert.equal(res.body.page.limit, 50);
  assert.equal(res.body.page.offset, 0);
});

test('GET list requires auth → 401', async () => {
  const { app } = await withCluster();
  assert.equal((await request(app).get('/api/incident-clusters')).status, 401);
});

test('GET list rejects an invalid status filter → 400', async () => {
  const { app } = await withCluster();
  const res = await request(app).get('/api/incident-clusters?status=bogus').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET list rejects a bad limit → 400', async () => {
  const { app } = await withCluster();
  const res = await request(app).get('/api/incident-clusters?limit=9999').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET list passes status + time-range + pagination to the repo', async () => {
  const seen = [];
  const incidentClustersRepo = makeIncidentClustersRepo({ list: async (f) => { seen.push(f); return []; }, count: async () => 0 });
  const app = makeApp({ incidentClustersRepo });
  const res = await request(app)
    .get('/api/incident-clusters?status=open&from=2026-07-01T00:00:00Z&to=2026-07-02T00:00:00Z&limit=10&offset=5')
    .set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(seen[0].status, 'open');
  assert.ok(seen[0].from instanceof Date);
  assert.ok(seen[0].to instanceof Date);
  assert.equal(seen[0].limit, 10);
  assert.equal(seen[0].offset, 5);
});

test('GET list returns a clean 500 on a repo failure (no stack leak)', async () => {
  const incidentClustersRepo = makeIncidentClustersRepo({ list: async () => { throw new Error('db exploded'); } });
  const app = makeApp({ incidentClustersRepo });
  const res = await request(app).get('/api/incident-clusters').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!/db exploded/.test(JSON.stringify(res.body.error))); // the message is not the surfaced error
  assert.ok(!('stack' in res.body));
});

// ---- GET /api/incident-clusters/:id ---------------------------------------

test('GET /:id returns full detail: members, root cause, confidence breakdown → 200', async () => {
  const { app, id } = await withCluster();
  const res = await request(app).get(`/api/incident-clusters/${id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const c = res.body.cluster;
  assert.equal(c.id, id);
  assert.equal(c.members.length, 2);
  assert.deepEqual(c.affectedAgents.sort(), ['1', '2']);
  assert.equal(c.suspectedRootCause.classification, 'network-layer');
  assert.ok(c.confidenceBreakdown.aboveBaseline);
  assert.ok(c.evidenceSummary.text.length > 0);
});

test('GET /:id is 400 for a non-numeric id', async () => {
  const { app } = await withCluster();
  const res = await request(app).get('/api/incident-clusters/abc').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /:id is 404 for an unknown cluster', async () => {
  const { app } = await withCluster();
  const res = await request(app).get('/api/incident-clusters/99999').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

// ---- POST /api/incident-clusters/:id/ack ----------------------------------

test('POST /:id/ack acknowledges the cluster (operator+) → 200', async () => {
  const { app, incidentClustersRepo, id } = await withCluster();
  const res = await request(app).post(`/api/incident-clusters/${id}/ack`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.cluster.status, 'acknowledged');
  assert.equal(incidentClustersRepo.rows.find((r) => r.id === id).status, 'acknowledged');
});

test('POST /:id/ack is forbidden for a viewer → 403', async () => {
  const { app, id } = await withCluster();
  const res = await request(app).post(`/api/incident-clusters/${id}/ack`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('POST /:id/ack requires auth → 401', async () => {
  const { app, id } = await withCluster();
  assert.equal((await request(app).post(`/api/incident-clusters/${id}/ack`)).status, 401);
});

test('POST /:id/ack is 404 for an unknown cluster', async () => {
  const { app } = await withCluster();
  const res = await request(app).post('/api/incident-clusters/99999/ack').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 404);
});

test('POST /:id/ack on an already-resolved cluster → 409', async () => {
  const { app, id } = await withCluster({ status: 'resolved' });
  const res = await request(app).post(`/api/incident-clusters/${id}/ack`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 409);
});

// ---- POST /api/incident-clusters/:id/resolve ------------------------------

test('POST /:id/resolve with a note resolves the cluster (operator+) → 200', async () => {
  const { app, incidentClustersRepo, id } = await withCluster();
  const res = await request(app)
    .post(`/api/incident-clusters/${id}/resolve`)
    .set('Authorization', authHeader('operator'))
    .send({ note: 'Shared WAN link flapped; carrier fixed it.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.cluster.status, 'resolved');
  const row = incidentClustersRepo.rows.find((r) => r.id === id);
  assert.equal(row.status, 'resolved');
  assert.equal(row.resolution_note, 'Shared WAN link flapped; carrier fixed it.');
});

test('POST /:id/resolve without a note → 400', async () => {
  const { app, id } = await withCluster();
  const res = await request(app)
    .post(`/api/incident-clusters/${id}/resolve`)
    .set('Authorization', authHeader('operator'))
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.details.note, 'a resolution note is required');
});

test('POST /:id/resolve with a blank note → 400', async () => {
  const { app, id } = await withCluster();
  const res = await request(app)
    .post(`/api/incident-clusters/${id}/resolve`)
    .set('Authorization', authHeader('operator'))
    .send({ note: '   ' });
  assert.equal(res.status, 400);
});

test('POST /:id/resolve is forbidden for a viewer → 403', async () => {
  const { app, id } = await withCluster();
  const res = await request(app)
    .post(`/api/incident-clusters/${id}/resolve`)
    .set('Authorization', authHeader('viewer'))
    .send({ note: 'x' });
  assert.equal(res.status, 403);
});

test('POST /:id/resolve is 404 for an unknown cluster', async () => {
  const { app } = await withCluster();
  const res = await request(app)
    .post('/api/incident-clusters/99999/resolve')
    .set('Authorization', authHeader('operator'))
    .send({ note: 'x' });
  assert.equal(res.status, 404);
});

test('POST /:id/resolve twice → second is 409', async () => {
  const { app, id } = await withCluster();
  const auth = authHeader('operator');
  await request(app).post(`/api/incident-clusters/${id}/resolve`).set('Authorization', auth).send({ note: 'first' });
  const res = await request(app).post(`/api/incident-clusters/${id}/resolve`).set('Authorization', auth).send({ note: 'second' });
  assert.equal(res.status, 409);
});
