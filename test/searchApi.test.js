'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeLocationsRepo, makeFlowsRepo, authHeader } = require('../test-support/fakes');
const { createFlowsRepository } = require('../src/repositories/flowsRepository');

const agents = [
  { id: 1, hostname: 'fw-aarhus', display_name: 'Firewall Aarhus', status: 'online', location_name: 'Aarhus' },
  { id: 2, hostname: 'gw-odense', display_name: null, status: 'offline', location_name: 'Odense' },
];

test('GET /api/search without a token is 401, and requires q (400)', async () => {
  assert.equal((await request(makeApp()).get('/api/search?q=x')).status, 401);
  assert.equal((await request(makeApp()).get('/api/search').set('Authorization', authHeader('viewer'))).status, 400);
});

test('GET /api/search matches agents by hostname/display name', async () => {
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findAll: async () => agents }) });
  const res = await request(app).get('/api/search?q=aarhus').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.agents.length, 1);
  assert.equal(res.body.agents[0].id, 1);
});

test('GET /api/search resolves an IP to the agents that saw it', async () => {
  const flowsRepo = makeFlowsRepo({ agentIdsForIp: async ({ ip }) => (ip === '8.8.8.8' ? [1, 2] : []) });
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findAll: async () => agents }), flowsRepo });
  const res = await request(app).get('/api/search?q=8.8.8.8').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.flows.ip.ip, '8.8.8.8');
  assert.deepEqual(res.body.flows.ip.agents.map((a) => a.id), [1, 2]);
  assert.equal(res.body.flows.ip.agents[0].name, 'Firewall Aarhus');
});

test('GET /api/search resolves a port to the agents that used it', async () => {
  let captured;
  const flowsRepo = makeFlowsRepo({ agentIdsForPort: async (args) => { captured = args; return [2]; } });
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findAll: async () => agents }), flowsRepo });
  const res = await request(app).get('/api/search?q=443').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.flows.port.port, 443);
  assert.equal(captured.port, 443);
  assert.equal(res.body.flows.port.agents[0].name, 'gw-odense'); // falls back to hostname
});

test('flowsRepository.agentIdsForIp binds the IP and windows the query', async () => {
  const queries = [];
  const pool = { async query(sql, params) { queries.push({ sql, params }); return [[{ agent_id: 5 }, { agent_id: 5 }, { agent_id: 6 }]]; } };
  const repo = createFlowsRepository({ pool });
  const ids = await repo.agentIdsForIp({ ip: '10.0.0.1', since: new Date('2026-06-01'), until: new Date('2026-06-02') });
  assert.deepEqual(ids, [5, 6]); // de-duplicated
  assert.match(queries[0].sql, /src_ip = \? OR dst_ip = \? OR ext_ip = \?/);
  assert.ok(!queries[0].sql.includes('10.0.0.1') && queries[0].params.includes('10.0.0.1'));
});
