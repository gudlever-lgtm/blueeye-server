'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCrossAgentCorrelator } = require('../src/analysis/crossAgentCorrelator');
const { createCrossAgentClusterService } = require('../src/analysis/crossAgentClusterService');
const { createLldpGraphService } = require('../src/topology/lldpGraphService');
const { makeLldpNeighborsRepo, makeIncidentClustersRepo, makeFindingStore, makeAgentsRepo } = require('../test-support/fakes');

const T = new Date('2026-07-01T12:00:00Z');
const ago = (ms) => new Date(T.getTime() - ms);
const finding = (o) => ({ severity: 'WARN', explanation: 'x', evidence: [{}], ...o });

// A topology resolver that reports every pair adjacent (for the correlator unit).
const allAdjacent = { related: (a, b) => ({ related: true, hops: 1, detail: `LLDP: ${a} adjacent to ${b}` }) };
const noneAdjacent = { related: () => ({ related: false, relation: 'unknown' }) };

// ---- correlator: LLDP topology pass ---------------------------------------

test('LLDP adjacency clusters two DIFFERENT-type findings; evidence names the source', () => {
  const cx = createCrossAgentCorrelator();
  const clusters = cx.detect([
    finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(90000) }),
    finding({ id: 'b', hostId: '2', metric: 'mem', createdAt: ago(30000) }),
  ], { siteOf: () => null, topology: allAdjacent });

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].topologySource, 'lldp');
  assert.equal(clusters[0].confidence, 'medium'); // topology, but no shared type
  assert.deepEqual(clusters[0].hostIds.sort(), ['1', '2']);
  assert.match(clusters[0].suspectedCommonCause, /LLDP/);
});

test('resolution order: shared site (manual) ALWAYS wins over LLDP', () => {
  const cx = createCrossAgentCorrelator();
  const clusters = cx.detect([
    finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(90000) }),
    finding({ id: 'b', hostId: '2', metric: 'cpu', createdAt: ago(30000) }),
  ], { siteOf: () => '10', topology: allAdjacent }); // both same site AND adjacent

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].topologySource, 'site'); // site consumed them first
  assert.equal(clusters[0].confidence, 'high');     // site + same type
  assert.doesNotMatch(clusters[0].suspectedCommonCause, /LLDP/);
});

test('unknown adjacency does NOT force a topology cluster (falls through to type-only low)', () => {
  const cx = createCrossAgentCorrelator();
  const clusters = cx.detect([
    finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(90000) }),
    finding({ id: 'b', hostId: '2', metric: 'cpu', createdAt: ago(30000) }),
  ], { siteOf: () => null, topology: noneAdjacent });

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].confidence, 'low');       // type-only, no topology
  assert.equal(clusters[0].signals.topology, false);
  assert.equal(clusters[0].topologySource, null);
});

test('no topology resolver → behaves exactly as site-only (no LLDP clusters)', () => {
  const cx = createCrossAgentCorrelator();
  const clusters = cx.detect([
    finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(90000) }),
    finding({ id: 'b', hostId: '2', metric: 'mem', createdAt: ago(30000) }),
  ], { siteOf: () => null }); // no topology
  // different types, different sites → NOT a topology cluster; time-only low.
  assert.equal(clusters[0].signals.topology, false);
});

// ---- service integration: LLDP graph → cluster ----------------------------

test('integration: two LLDP-adjacent agents at DIFFERENT sites cluster via the LLDP signal', async () => {
  const repo = makeLldpNeighborsRepo();
  // agents 1 (chassis A) and 2 (chassis B) share switch S1 → adjacent.
  await repo.upsertMany(1, [{ localChassisId: 'A', remoteChassisId: 'S1' }], { lastSeen: ago(60000) });
  await repo.upsertMany(2, [{ localChassisId: 'B', remoteChassisId: 'S1' }], { lastSeen: ago(60000) });
  const topologyGraph = createLldpGraphService({ lldpNeighborsRepo: repo, now: () => T.getTime() });

  const findingStore = makeFindingStore();
  findingStore.rows.push(finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(90000), acked: false }));
  findingStore.rows.push(finding({ id: 'b', hostId: '2', metric: 'mem', createdAt: ago(30000), acked: false }));

  const clustersRepo = makeIncidentClustersRepo();
  // Different sites, so the manual/site pass does NOT group them — LLDP must.
  const agentsRepo = makeAgentsRepo({ findAll: async () => [{ id: 1, location_id: 10 }, { id: 2, location_id: 20 }] });

  const svc = createCrossAgentClusterService({ clustersRepo, findingStore, agentsRepo, topologyGraph, now: () => T });
  const summary = await svc.detectAndPersist();

  assert.equal(summary.created, 1);
  assert.equal(clustersRepo.rows.length, 1);
  assert.equal(clustersRepo.rows[0].confidence, 'medium');       // topology, mixed types
  assert.match(clustersRepo.rows[0].suspected_common_cause, /LLDP/);
});
