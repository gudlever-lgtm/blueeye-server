'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEvidenceRetention } = require('../src/evidence/evidenceRetention');
const { makeEvidenceSnapshotsRepo, makeIncidentClustersRepo, makeFindingStore } = require('../test-support/fakes');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-16T00:00:00Z');

// Opens + completes a snapshot for a cluster at a given age (days ago).
async function seedSnapshot(evidenceRepo, clusterId, ageDays) {
  const id = await evidenceRepo.create({
    clusterId, target: String(clusterId), commandSetVersion: 'evidence-v1',
    capturedAt: new Date(NOW.getTime() - ageDays * DAY), trigger: 'auto',
  });
  await evidenceRepo.complete(id, { status: 'complete', items: [], payloadText: 'x' });
  return id;
}

test('ages out snapshots older than the retention window', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const clustersRepo = makeIncidentClustersRepo();
  await seedSnapshot(evidenceRepo, 1, 120); // stale
  await seedSnapshot(evidenceRepo, 2, 10);  // fresh
  const retention = createEvidenceRetention({ evidenceRepo, clustersRepo, findingStore: makeFindingStore(), retentionDays: 90, now: () => NOW });
  const res = await retention.run();
  assert.equal(res.deleted, 1);
  assert.deepEqual(evidenceRepo.rows.map((r) => r.cluster_id), [2]);
});

test('never deletes evidence on a cluster with an unacknowledged CRIT finding', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const clustersRepo = makeIncidentClustersRepo();
  const findingStore = makeFindingStore();
  // Cluster 1: has a stale snapshot AND an unacknowledged CRIT member → protected.
  findingStore.rows.push({ id: 'crit', hostId: '1', severity: 'CRIT', acked: false, metric: 'probe.loss', kind: 'THRESHOLD', explanation: 'x', evidence: [{}], createdAt: NOW });
  const protectedId = await clustersRepo.create({ confidence: 'high', memberFindingIds: ['crit'], status: 'open', detectedAt: NOW });
  // Cluster 2: a stale snapshot but only an ACKED CRIT → not protected.
  findingStore.rows.push({ id: 'acked', hostId: '2', severity: 'CRIT', acked: true, metric: 'probe.loss', kind: 'THRESHOLD', explanation: 'x', evidence: [{}], createdAt: NOW });
  const unprotectedId = await clustersRepo.create({ confidence: 'high', memberFindingIds: ['acked'], status: 'open', detectedAt: NOW });

  await seedSnapshot(evidenceRepo, protectedId, 200);
  await seedSnapshot(evidenceRepo, unprotectedId, 200);

  const retention = createEvidenceRetention({ evidenceRepo, clustersRepo, findingStore, retentionDays: 90, now: () => NOW });
  const res = await retention.run();
  assert.equal(res.deleted, 1);
  assert.deepEqual(res.protectedClusters, [protectedId]);
  // The protected cluster's snapshot survives; the other is gone.
  assert.deepEqual(evidenceRepo.rows.map((r) => r.cluster_id), [protectedId]);
});

test('run() never throws on a repo failure', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo({ clusterIdsWithSnapshotsOlderThan: async () => { throw new Error('db down'); } });
  const retention = createEvidenceRetention({ evidenceRepo, clustersRepo: makeIncidentClustersRepo(), findingStore: makeFindingStore(), now: () => NOW });
  const res = await retention.run();
  assert.deepEqual(res, { deleted: 0, protectedClusters: [] });
});
