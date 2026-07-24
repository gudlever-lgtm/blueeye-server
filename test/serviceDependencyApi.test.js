'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeServiceDependenciesRepo, makeAgentsRepo, makeFlowsRepo, authHeader,
} = require('../test-support/fakes');
const { createServiceDependencyJob } = require('../src/topology/serviceDependencyJob');

const AGENTS = [
  { id: 1, hostname: 'web-1', capabilities: { ips: ['10.0.0.1'] } },
  { id: 2, hostname: 'db-1', capabilities: { ips: ['10.0.0.2'] } },
];
const agentsRepo = () => makeAgentsRepo({
  findAll: async () => AGENTS,
  findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null,
});

async function seededRepo() {
  const repo = makeServiceDependenciesRepo();
  await repo.upsert({ srcHostId: 1, dstHostId: 2, dstPort: 443, bytes: 5000, packets: 40, connCount: 12, firstSeen: new Date('2026-07-24T00:00:00Z'), lastSeen: new Date('2026-07-24T10:00:00Z') });
  await repo.upsert({ srcHostId: 1, dstHostId: 2, dstPort: 5432, bytes: 3000, packets: 20, connCount: 6, firstSeen: new Date('2026-07-24T01:00:00Z'), lastSeen: new Date('2026-07-24T10:00:00Z') });
  return repo;
}

test('GET /api/topology/dependencies lists edges (viewer+) → 200', async () => {
  const app = makeApp({ serviceDependenciesRepo: await seededRepo(), agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/dependencies').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.edges.length, 2);
  assert.equal(res.body.edges[0].dstPort, 443); // heaviest first
});

test('GET /api/topology/dependencies requires auth → 401', async () => {
  const app = makeApp({ serviceDependenciesRepo: await seededRepo(), agentsRepo: agentsRepo() });
  assert.equal((await request(app).get('/api/topology/dependencies')).status, 401);
});

test('GET /api/topology/dependencies?host= filters to that host + Top-N', async () => {
  const app = makeApp({ serviceDependenciesRepo: await seededRepo(), agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/dependencies?host=1&limit=1').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.host, 1);
  assert.equal(res.body.edges.length, 1); // truncated to 1
  assert.equal(res.body.edges[0].dstPort, 443);
  assert.equal(res.body.page.total, 2);
});

test('GET /api/topology/dependencies?host= unknown host → 404', async () => {
  const app = makeApp({ serviceDependenciesRepo: await seededRepo(), agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/dependencies?host=999').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /api/topology/dependencies?host= invalid → 400', async () => {
  const app = makeApp({ serviceDependenciesRepo: await seededRepo(), agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/dependencies?host=abc').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('POST /api/topology/dependencies/recompute is a write path — viewer → 403', async () => {
  const app = makeApp({ serviceDependenciesRepo: await seededRepo(), agentsRepo: agentsRepo() });
  const res = await request(app).post('/api/topology/dependencies/recompute').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('GET /api/topology/dependencies → 500 when the DB is unavailable', async () => {
  const serviceDependenciesRepo = makeServiceDependenciesRepo({
    listAll: async () => { throw new Error('DB down'); },
  });
  const app = makeApp({ serviceDependenciesRepo, agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/dependencies').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

test('GET /api/topology/graph returns a unified graph with both edge types', async () => {
  const serviceDependenciesRepo = await seededRepo();
  // Two agents adjacent at L2: both report the same remote switch chassis.
  const lldpNeighborsRepo = require('../test-support/fakes').makeLldpNeighborsRepo();
  await lldpNeighborsRepo.upsert({ localAgentId: 1, localChassisId: 'chassis-1', remoteChassisId: 'chassis-2' });
  await lldpNeighborsRepo.upsert({ localAgentId: 2, localChassisId: 'chassis-2', remoteChassisId: 'chassis-1' });
  const app = makeApp({ serviceDependenciesRepo, lldpNeighborsRepo, agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/graph').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.totals.service_dep, 2);
  assert.equal(res.body.totals.l2_link, 1);
  const types = new Set(res.body.edges.map((e) => e.type));
  assert.ok(types.has('l2_link') && types.has('service_dep'));
  const dep = res.body.edges.find((e) => e.type === 'service_dep');
  assert.equal(dep.directed, true);
  const l2 = res.body.edges.find((e) => e.type === 'l2_link');
  assert.equal(l2.directed, false);
});

test('recompute job (operator+) aggregates flows→edges end to end', async () => {
  const serviceDependenciesRepo = makeServiceDependenciesRepo();
  const flowsRepo = makeFlowsRepo({
    tcpServiceFlows: async () => ([
      { srcIp: '10.0.0.1', dstIp: '10.0.0.2', dstPort: 443, bytes: 1200, packets: 10, connCount: 4, firstSeen: new Date('2026-07-24T09:00:00Z'), lastSeen: new Date('2026-07-24T10:00:00Z') },
      { srcIp: '10.0.0.1', dstIp: '8.8.8.8', dstPort: 443, bytes: 999, packets: 9, connCount: 1, firstSeen: new Date(), lastSeen: new Date() }, // dropped: unknown
    ]),
  });
  const agents = agentsRepo();
  const serviceDependencyJob = createServiceDependencyJob({ serviceDependenciesRepo, flowsRepo, agentsRepo: agents, logger: null });
  const app = makeApp({ serviceDependenciesRepo, agentsRepo: agents, serviceDependencyJob });

  const res = await request(app).post('/api/topology/dependencies/recompute').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.stats.edges, 1); // only the resolvable edge survives

  const list = await request(app).get('/api/topology/dependencies').set('Authorization', authHeader('viewer'));
  assert.equal(list.body.edges.length, 1);
  assert.equal(list.body.edges[0].srcHostId, 1);
  assert.equal(list.body.edges[0].dstHostId, 2);
  assert.equal(list.body.edges[0].dstPort, 443);
  assert.equal(list.body.edges[0].bytes, 1200);
});
