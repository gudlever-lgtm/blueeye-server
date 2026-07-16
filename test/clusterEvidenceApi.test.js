'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeIncidentClustersRepo, makeFindingStore, makeEvidenceSnapshotsRepo,
  makeAuditLogRepo, authHeader,
} = require('../test-support/fakes');

// Seeds a repo + finding store with one open cluster whose members live on two
// hosts, plus a fake evidence repo (optionally pre-seeded) and a spy snapshot
// service so the manual-resnapshot path can be observed without a real agent.
async function withEvidence(over = {}) {
  const incidentClustersRepo = over.incidentClustersRepo || makeIncidentClustersRepo();
  const findingStore = over.findingStore || makeFindingStore();
  const evidenceRepo = over.evidenceRepo || makeEvidenceSnapshotsRepo();
  const auditLogRepo = over.auditLogRepo || makeAuditLogRepo();
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
  const captures = [];
  const snapshotService = over.snapshotService || {
    captureForCluster: async (clusterId, targets, opts) => { captures.push({ clusterId, targets, opts }); return { snapshots: [] }; },
  };
  const app = makeApp({ incidentClustersRepo, findingStore, evidenceRepo, snapshotService, auditLogRepo });
  return { app, incidentClustersRepo, findingStore, evidenceRepo, auditLogRepo, snapshotService, captures, id, members };
}

// ---- GET /api/incident-clusters/:id/evidence ------------------------------

test('GET /:id/evidence lists snapshots for the cluster (viewer+) → 200', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const sid = await evidenceRepo.create({ clusterId: 0, target: '1', commandSetVersion: 'evidence-v1', capturedAt: new Date('2026-07-01T12:05:00Z'), trigger: 'auto' });
  await evidenceRepo.complete(sid, { status: 'complete', items: [{ name: 'agent.state', status: 'ok' }], payloadText: '# agent.state [ok]\nconnected: yes' });
  // The seeded snapshot must point at the cluster the helper creates (id 1).
  evidenceRepo.rows[0].cluster_id = 1;
  const { app, id } = await withEvidence({ evidenceRepo });
  const res = await request(app).get(`/api/incident-clusters/${id}/evidence`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.clusterId, id);
  assert.equal(res.body.snapshots.length, 1);
  assert.equal(res.body.snapshots[0].status, 'complete');
  assert.equal(res.body.snapshots[0].target, '1');
  // Metadata only — the blob is never inlined in the list.
  assert.ok(!('payload' in res.body.snapshots[0]));
});

test('GET /:id/evidence requires auth → 401', async () => {
  const { app, id } = await withEvidence();
  assert.equal((await request(app).get(`/api/incident-clusters/${id}/evidence`)).status, 401);
});

test('GET /:id/evidence is 404 for an unknown cluster', async () => {
  const { app } = await withEvidence();
  const res = await request(app).get('/api/incident-clusters/99999/evidence').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /:id/evidence is 400 for a non-numeric id', async () => {
  const { app } = await withEvidence();
  const res = await request(app).get('/api/incident-clusters/abc/evidence').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

// ---- GET /api/incident-clusters/:id/evidence/:sid -------------------------

test('GET /:id/evidence/:sid returns the raw-text payload (text/plain) → 200', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const sid = await evidenceRepo.create({ clusterId: 1, target: '1', commandSetVersion: 'evidence-v1', capturedAt: new Date('2026-07-01T12:05:00Z'), trigger: 'auto' });
  await evidenceRepo.complete(sid, { status: 'complete', items: [{ name: 'agent.state', status: 'ok' }], payloadText: '# agent.state [ok]\nconnected: yes' });
  const { app, id } = await withEvidence({ evidenceRepo });
  const res = await request(app).get(`/api/incident-clusters/${id}/evidence/${sid}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.text, /connected: yes/);
});

test('GET /:id/evidence/:sid is 404 when the snapshot belongs to another cluster', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const sid = await evidenceRepo.create({ clusterId: 999, target: '1', commandSetVersion: 'evidence-v1', capturedAt: new Date(), trigger: 'auto' });
  await evidenceRepo.complete(sid, { status: 'complete', items: [], payloadText: 'x' });
  const { app, id } = await withEvidence({ evidenceRepo });
  const res = await request(app).get(`/api/incident-clusters/${id}/evidence/${sid}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

// ---- POST /api/incident-clusters/:id/evidence (manual re-snapshot) ---------

test('POST /:id/evidence triggers a manual capture of the cluster targets (operator+) → 202', async () => {
  const { app, id, captures, auditLogRepo } = await withEvidence();
  const res = await request(app).post(`/api/incident-clusters/${id}/evidence`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 202);
  assert.equal(res.body.clusterId, id);
  assert.deepEqual(res.body.targets.sort(), ['1', '2']);
  // Fire-and-forget capture was invoked with the manual trigger.
  await new Promise((r) => setImmediate(r));
  assert.equal(captures.length, 1);
  assert.equal(captures[0].opts.trigger, 'manual');
  assert.deepEqual(captures[0].targets.sort(), ['1', '2']);
  // Manual re-snapshot is audit-logged as an evidence-class action.
  assert.ok(auditLogRepo.rows.some((r) => r.action === 'evidence_resnapshot' && String(r.target) === String(id)));
});

test('POST /:id/evidence is forbidden for a viewer → 403', async () => {
  const { app, id } = await withEvidence();
  const res = await request(app).post(`/api/incident-clusters/${id}/evidence`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('POST /:id/evidence requires auth → 401', async () => {
  const { app, id } = await withEvidence();
  assert.equal((await request(app).post(`/api/incident-clusters/${id}/evidence`)).status, 401);
});

test('POST /:id/evidence is 404 for an unknown cluster', async () => {
  const { app } = await withEvidence();
  const res = await request(app).post('/api/incident-clusters/99999/evidence').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 404);
});

test('POST /:id/evidence is rate-limited to once per window → 429 with Retry-After', async () => {
  const { app, id } = await withEvidence();
  const first = await request(app).post(`/api/incident-clusters/${id}/evidence`).set('Authorization', authHeader('operator'));
  assert.equal(first.status, 202);
  const second = await request(app).post(`/api/incident-clusters/${id}/evidence`).set('Authorization', authHeader('operator'));
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers['retry-after']) > 0);
  assert.ok(second.body.retryAfterSec > 0);
});
