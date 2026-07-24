'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeTopologyChangesRepo, makeLldpNeighborsRepo, makeAgentsRepo, makeAgentTokensRepo, authHeader,
} = require('../test-support/fakes');

const agentsRepo = () => makeAgentsRepo({
  findById: async (id) => (Number(id) === 9 ? { id: 9, hostname: 'sw-1' } : null),
  setCapabilities: async (id, capabilities) => ({ id, capabilities }),
});
// Agent token authenticating as agent id 9.
const agentTokens = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

async function seededChanges() {
  const repo = makeTopologyChangesRepo();
  await repo.insert({ agentId: 9, changeType: 'neighbour_added', localPort: 'eth1', remoteChassisId: 'sw-b', remotePort: 'gi1', severity: 'INFO', summary: 'Neighbour sw-b added on eth1', detectedAt: new Date('2026-07-24T10:00:00Z') });
  await repo.insert({ agentId: 9, changeType: 'link_state_changed', localPort: 'eth0', remoteChassisId: 'sw-a', linkStateFrom: 'up', linkStateTo: 'down', severity: 'WARN', summary: 'Link up→down for sw-a on eth0', detectedAt: new Date('2026-07-24T10:05:00Z') });
  return repo;
}

test('GET /api/topology/changes returns timeline-shaped events (operator+)', async () => {
  const app = makeApp({ topologyChangesRepo: await seededChanges(), agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/changes?host=9').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 2);
  const e = res.body.events[0];
  // Exactly the target-timeline event shape — no second changes format.
  assert.deepEqual(Object.keys(e).sort(), ['ref_id', 'severity', 'source', 'summary', 'timestamp', 'type'].sort());
  assert.equal(e.source, 'topology');
  assert.ok(e.type.startsWith('topology.'));
});

test('GET /api/topology/changes requires auth → 401', async () => {
  const app = makeApp({ topologyChangesRepo: await seededChanges(), agentsRepo: agentsRepo() });
  assert.equal((await request(app).get('/api/topology/changes')).status, 401);
});

test('GET /api/topology/changes enforces role → 403 for viewer', async () => {
  const app = makeApp({ topologyChangesRepo: await seededChanges(), agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/changes').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('GET /api/topology/changes?host= unknown host → 404', async () => {
  const app = makeApp({ topologyChangesRepo: await seededChanges(), agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/changes?host=999').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 404);
});

test('GET /api/topology/changes?host= invalid → 400', async () => {
  const app = makeApp({ topologyChangesRepo: await seededChanges(), agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/changes?host=abc').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 400);
});

test('GET /api/topology/changes → 500 when the store fails', async () => {
  const topologyChangesRepo = makeTopologyChangesRepo({ list: async () => { throw new Error('DB down'); } });
  const app = makeApp({ topologyChangesRepo, agentsRepo: agentsRepo() });
  const res = await request(app).get('/api/topology/changes').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 500);
});

// ---- End-to-end: capabilities ingest detects + records a change --------------

test('reporting LLDP via capabilities detects a change, recorded + on the timeline', async () => {
  const topologyChangesRepo = makeTopologyChangesRepo();
  const lldpNeighborsRepo = makeLldpNeighborsRepo();
  const app = makeApp({ topologyChangesRepo, lldpNeighborsRepo, agentsRepo: agentsRepo(), agentTokensRepo: agentTokens() });

  // First report: one neighbour appears → neighbour_added.
  const post = await request(app)
    .post('/agents/me/capabilities')
    .set('Authorization', 'Bearer any-agent-token')
    .send({ capabilities: { sources: ['sflow'], lldpChassisId: 'me', lldp: [{ localPort: 'eth1', remoteChassisId: 'sw-b', remotePort: 'gi1' }] } });
  assert.equal(post.status, 200);

  assert.equal(topologyChangesRepo.rows.length, 1);
  assert.equal(topologyChangesRepo.rows[0].change_type, 'neighbour_added');

  // The change surfaces on the target timeline (viewer+) as a 'topology' source.
  const tl = await request(app).get('/api/targets/9/timeline').set('Authorization', authHeader('viewer'));
  assert.equal(tl.status, 200);
  const topo = tl.body.events.filter((e) => e.source === 'topology');
  assert.equal(topo.length, 1);
  assert.equal(topo[0].type, 'topology.neighbour_added');
});
