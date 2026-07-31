'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeServiceDependenciesRepo, makeLldpNeighborsRepo, makeAgentsRepo,
  makeEventCasesRepo, makeFindingStore, authHeader,
} = require('../test-support/fakes');

const AGENTS = [
  { id: 1, hostname: 'sw-core' }, { id: 2, hostname: 'sw-edge' },
  { id: 3, hostname: 'app-1' }, { id: 4, hostname: 'web-1' },
];
const agentsRepo = () => makeAgentsRepo({
  findAll: async () => AGENTS,
  findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null,
});

// Topology: 1 —L2— 2 —L2— 3 ; app 4 depends on 3 :5432.
async function topology() {
  const lldpNeighborsRepo = makeLldpNeighborsRepo();
  // agent 1<->2 adjacent (both know each other's chassis), 2<->3 adjacent.
  await lldpNeighborsRepo.upsert({ localAgentId: 1, localChassisId: 'c1', remoteChassisId: 'c2' });
  await lldpNeighborsRepo.upsert({ localAgentId: 2, localChassisId: 'c2', remoteChassisId: 'c1' });
  await lldpNeighborsRepo.upsert({ localAgentId: 2, localChassisId: 'c2', remoteChassisId: 'c3' });
  await lldpNeighborsRepo.upsert({ localAgentId: 3, localChassisId: 'c3', remoteChassisId: 'c2' });
  const serviceDependenciesRepo = makeServiceDependenciesRepo();
  await serviceDependenciesRepo.upsert({ srcHostId: 4, dstHostId: 3, dstPort: 5432, bytes: 100, packets: 1, connCount: 1, firstSeen: new Date(), lastSeen: new Date() });
  return { lldpNeighborsRepo, serviceDependenciesRepo };
}

test('GET /api/topology/blast-radius/:node returns both tiers (operator+)', async () => {
  const { lldpNeighborsRepo, serviceDependenciesRepo } = await topology();
  const app = makeApp({ lldpNeighborsRepo, serviceDependenciesRepo, agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/blast-radius/1').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.failingNode, 1);
  // 1 fails -> L2 isolates 2 and 3; app 4 depends on 3 -> dependency_affected.
  assert.deepEqual(res.body.directly_isolated.map((e) => e.hostId).sort(), [2, 3]);
  assert.deepEqual(res.body.dependency_affected.map((e) => e.hostId), [4]);
  assert.equal(res.body.dependency_affected[0].path.at(-1).viaPort, 5432);
});

test('GET /api/topology/blast-radius/:node → 404 for an unknown node', async () => {
  const { lldpNeighborsRepo, serviceDependenciesRepo } = await topology();
  const app = makeApp({ lldpNeighborsRepo, serviceDependenciesRepo, agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/blast-radius/999').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 404);
});

test('GET /api/topology/blast-radius/:node enforces role → 403 for viewer', async () => {
  const { lldpNeighborsRepo, serviceDependenciesRepo } = await topology();
  const app = makeApp({ lldpNeighborsRepo, serviceDependenciesRepo, agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/blast-radius/1').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('GET /api/topology/blast-radius/:node requires auth → 401', async () => {
  const { lldpNeighborsRepo, serviceDependenciesRepo } = await topology();
  const app = makeApp({ lldpNeighborsRepo, serviceDependenciesRepo, agentsRepo: agentsRepo() });
  assert.equal((await request(app).get('/api/topology/blast-radius/1')).status, 401);
});

test('GET /api/topology/blast-radius/:node → 400 for a non-integer node', async () => {
  const { lldpNeighborsRepo, serviceDependenciesRepo } = await topology();
  const app = makeApp({ lldpNeighborsRepo, serviceDependenciesRepo, agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/blast-radius/abc').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 400);
});

test('GET /api/topology/blast-radius/:node → 500 when the topology store fails', async () => {
  const serviceDependenciesRepo = makeServiceDependenciesRepo();
  const lldpNeighborsRepo = makeLldpNeighborsRepo({ listAll: async () => { throw new Error('DB down'); } });
  const app = makeApp({ lldpNeighborsRepo, serviceDependenciesRepo, agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/blast-radius/1').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 500);
});

test('depth cap is honoured via ?depth', async () => {
  const { lldpNeighborsRepo, serviceDependenciesRepo } = await topology();
  const app = makeApp({ lldpNeighborsRepo, serviceDependenciesRepo, agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/blast-radius/1?depth=1').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.depthCap, 1);
  assert.deepEqual(res.body.directly_isolated.map((e) => e.hostId), [2]); // 3 is 2 hops away
});

// ---- Event enrichment (one added field, computed on read, viewer+) --------

function eventSetup() {
  const eventCasesRepo = makeEventCasesRepo({
    findById: async (id) => (Number(id) === 7 ? { id: 7, hostId: '1', title: 'core down', status: 'open', severity: 'CRIT', primaryFindingId: null } : null),
  });
  const findingStore = makeFindingStore({ listByEventCase: async () => [] });
  return { eventCasesRepo, findingStore };
}

test('GET /api/events/:id carries a blastRadius enrichment field (viewer+)', async () => {
  const { lldpNeighborsRepo, serviceDependenciesRepo } = await topology();
  const { eventCasesRepo, findingStore } = eventSetup();
  const app = makeApp({ lldpNeighborsRepo, serviceDependenciesRepo, agentsRepo: agentsRepo(), eventCasesRepo, findingStore });
  const res = await request(app).get('/api/events/7').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.ok(res.body.event.blastRadius, 'event.blastRadius present');
  assert.equal(res.body.event.blastRadius.failingNode, 1);
  assert.deepEqual(res.body.event.blastRadius.directly_isolated.map((e) => e.hostId).sort(), [2, 3]);
  assert.deepEqual(res.body.event.blastRadius.dependency_affected.map((e) => e.hostId), [4]);
});

test('event enrichment is best-effort — a topology DB failure does not break the event view', async () => {
  const serviceDependenciesRepo = makeServiceDependenciesRepo();
  const lldpNeighborsRepo = makeLldpNeighborsRepo({ listAll: async () => { throw new Error('DB down'); } });
  const { eventCasesRepo, findingStore } = eventSetup();
  const app = makeApp({ lldpNeighborsRepo, serviceDependenciesRepo, agentsRepo: agentsRepo(), eventCasesRepo, findingStore });
  const res = await request(app).get('/api/events/7').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200); // NOT 500 — enrichment failed, event still served
  assert.equal(res.body.event.blastRadius, null);
});
