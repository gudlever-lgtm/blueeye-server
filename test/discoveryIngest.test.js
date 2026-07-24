'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeDiscoveredDevicesRepo, makeAgentsRepo, makeAgentTokensRepo } = require('../test-support/fakes');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

test('POST /agents/discovery-results ingests candidates tagged with the finding agent', async () => {
  const discoveredDevicesRepo = makeDiscoveredDevicesRepo();
  const app = makeApp({ discoveredDevicesRepo, agentsRepo: makeAgentsRepo(), agentTokensRepo: agentToken() });
  const res = await request(app)
    .post('/agents/discovery-results')
    .set('Authorization', 'Bearer agent-tok')
    .send({ scope: ['192.168.1.0/24'], derivedFromSelf: true, addresses: 256, probed: 12, candidates: [
      { ip: '192.168.1.5', hostname: 'printer.lan', openPorts: [80, 443], icmp: true },
      { ip: '192.168.1.9', hostname: null, openPorts: [22], icmp: false },
    ] });
  assert.equal(res.status, 202);
  assert.equal(res.body.ingested, 2);
  assert.equal(discoveredDevicesRepo.rows.length, 2);
  assert.equal(discoveredDevicesRepo.rows[0].found_by_agent_id, 9); // tagged with the agent from the token
  assert.equal(discoveredDevicesRepo.rows[0].status, 'discovered'); // never auto-enrolled
});

test('POST /agents/discovery-results with a refusal ingests nothing but 202s', async () => {
  const discoveredDevicesRepo = makeDiscoveredDevicesRepo();
  const app = makeApp({ discoveredDevicesRepo, agentsRepo: makeAgentsRepo(), agentTokensRepo: agentToken() });
  const res = await request(app)
    .post('/agents/discovery-results')
    .set('Authorization', 'Bearer agent-tok')
    .send({ refused: true, reason: 'scope_too_large', scope: ['10.0.0.0/8'], candidates: [] });
  assert.equal(res.status, 202);
  assert.equal(res.body.refused, true);
  assert.equal(discoveredDevicesRepo.rows.length, 0);
});

test('POST /agents/discovery-results requires an agent token → 401', async () => {
  const app = makeApp({ discoveredDevicesRepo: makeDiscoveredDevicesRepo(), agentsRepo: makeAgentsRepo(), agentTokensRepo: makeAgentTokensRepo({ findActiveByHash: async () => null }) });
  const res = await request(app).post('/agents/discovery-results').set('Authorization', 'Bearer bad').send({ candidates: [] });
  assert.equal(res.status, 401);
});

test('POST /agents/discovery-results skips malformed candidates', async () => {
  const discoveredDevicesRepo = makeDiscoveredDevicesRepo();
  const app = makeApp({ discoveredDevicesRepo, agentsRepo: makeAgentsRepo(), agentTokensRepo: agentToken() });
  const res = await request(app)
    .post('/agents/discovery-results')
    .set('Authorization', 'Bearer agent-tok')
    .send({ candidates: [{ ip: '192.168.1.5', openPorts: [80] }, { ip: '' }, { hostname: 'x' }, null] });
  assert.equal(res.status, 202);
  assert.equal(res.body.ingested, 1);
});
