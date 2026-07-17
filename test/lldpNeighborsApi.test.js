'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeLldpNeighborsRepo, makeAgentsRepo, makeAgentTokensRepo, authHeader } = require('../test-support/fakes');

// An agent token that authenticates as agent id 9 (mirrors agentConfig.test.js).
const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

async function appWith(over = {}) {
  const lldpNeighborsRepo = over.lldpNeighborsRepo || makeLldpNeighborsRepo();
  const agentsRepo = over.agentsRepo || makeAgentsRepo({ findById: async (id) => (Number(id) === 1 || Number(id) === 2 ? { id: Number(id) } : null) });
  await lldpNeighborsRepo.upsert({ localAgentId: 1, localChassisId: 'A', localPort: 'eth0', remoteChassisId: 'S1', remotePort: 'gi1' });
  await lldpNeighborsRepo.upsert({ localAgentId: 2, localChassisId: 'B', localPort: 'eth0', remoteChassisId: 'S1', remotePort: 'gi2' });
  const app = makeApp({ lldpNeighborsRepo, agentsRepo });
  return { app, lldpNeighborsRepo };
}

test('GET /api/topology/neighbors lists with pagination (viewer+) → 200', async () => {
  const { app } = await appWith();
  const res = await request(app).get('/api/topology/neighbors').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.neighbors.length, 2);
  assert.equal(res.body.page.total, 2);
  assert.equal(res.body.page.limit, 50);
});

test('GET /api/topology/neighbors requires auth → 401', async () => {
  const { app } = await appWith();
  assert.equal((await request(app).get('/api/topology/neighbors')).status, 401);
});

test('GET /api/topology/neighbors filters by target', async () => {
  const seen = [];
  const lldpNeighborsRepo = makeLldpNeighborsRepo({ list: async (f) => { seen.push(f); return []; }, count: async () => 0 });
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 1 }) });
  const app = makeApp({ lldpNeighborsRepo, agentsRepo });
  const res = await request(app).get('/api/topology/neighbors?target=1&limit=10&offset=5').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(seen[0].targetAgentId, 1);
  assert.equal(seen[0].limit, 10);
  assert.equal(seen[0].offset, 5);
});

test('GET /api/topology/neighbors 400 on an invalid target', async () => {
  const { app } = await appWith();
  const res = await request(app).get('/api/topology/neighbors?target=abc').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/topology/neighbors 400 on a bad limit', async () => {
  const { app } = await appWith();
  const res = await request(app).get('/api/topology/neighbors?limit=9999').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/topology/neighbors 404 for an unknown target agent', async () => {
  const { app } = await appWith();
  const res = await request(app).get('/api/topology/neighbors?target=999').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /api/topology/neighbors returns a clean 500 on repo failure (no stack leak)', async () => {
  const lldpNeighborsRepo = makeLldpNeighborsRepo({ list: async () => { throw new Error('db exploded'); } });
  const app = makeApp({ lldpNeighborsRepo });
  const res = await request(app).get('/api/topology/neighbors').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!/exploded/.test(String(res.body.error)));
});

// ---- ingest via the existing capabilities report path ----------------------

test('agent capabilities with an lldp[] list upserts neighbors (reuses the report path)', async () => {
  const lldpNeighborsRepo = makeLldpNeighborsRepo();
  const agentsRepo = makeAgentsRepo({ setCapabilities: async (id, caps) => ({ id, capabilities: caps }) });
  const app = makeApp({ lldpNeighborsRepo, agentsRepo, agentTokensRepo: agentToken() });
  const res = await request(app)
    .post('/agents/me/capabilities')
    .set('Authorization', 'Bearer agent-tok')
    .send({ capabilities: { sources: ['snmp'], lldpChassisId: 'A', lldp: [{ localPort: 'eth0', remoteChassisId: 'S1', remotePort: 'gi1' }] } });
  assert.equal(res.status, 200);
  assert.equal(lldpNeighborsRepo.rows.length, 1);
  assert.equal(lldpNeighborsRepo.rows[0].local_agent_id, 9); // agent id from the token
  assert.equal(lldpNeighborsRepo.rows[0].remote_chassis_id, 'S1');
  assert.equal(lldpNeighborsRepo.rows[0].local_chassis_id, 'A');
});

test('agent capabilities WITHOUT lldp does not touch the neighbor table', async () => {
  const lldpNeighborsRepo = makeLldpNeighborsRepo();
  const agentsRepo = makeAgentsRepo({ setCapabilities: async (id, caps) => ({ id, capabilities: caps }) });
  const app = makeApp({ lldpNeighborsRepo, agentsRepo, agentTokensRepo: agentToken() });
  const res = await request(app)
    .post('/agents/me/capabilities')
    .set('Authorization', 'Bearer agent-tok')
    .send({ capabilities: { sources: ['proc'] } });
  assert.equal(res.status, 200);
  assert.equal(lldpNeighborsRepo.rows.length, 0);
});
