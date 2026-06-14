'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFlowsRepo, makeAgentsRepo, authHeader } = require('../test-support/fakes');

const sampleEdges = [
  { srcIp: '10.0.0.5', dstIp: '8.8.8.8', extIp: '8.8.8.8', asn: 15169, asnName: 'GOOGLE', country: 'US', bytes: 9000, packets: 90, flowCount: 9 },
  { srcIp: '10.0.0.5', dstIp: '10.0.0.6', extIp: null, bytes: 4000, packets: 40, flowCount: 4 },
];

test('GET /api/topology requires auth (401)', async () => {
  assert.equal((await request(makeApp()).get('/api/topology')).status, 401);
});

test('GET /api/topology returns a flow-derived graph', async () => {
  const flowsRepo = makeFlowsRepo({ topologyEdges: async () => sampleEdges });
  const res = await request(makeApp({ flowsRepo }))
    .get('/api/topology?minutes=30').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.nodes.length, 3);
  assert.equal(res.body.edges.length, 2);
  assert.equal(res.body.totals.external, 1);
  assert.ok(res.body.from && res.body.to);
});

test('GET /api/topology validates agentId and 404s an unknown agent', async () => {
  const flowsRepo = makeFlowsRepo({ topologyEdges: async () => [] });
  const app = makeApp({ flowsRepo, agentsRepo: makeAgentsRepo({ findById: async () => null }) });
  assert.equal((await request(app).get('/api/topology?agentId=abc').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app).get('/api/topology?agentId=999').set('Authorization', authHeader('viewer'))).status, 404);
});

test('GET /api/topology scopes to one agent when agentId is valid', async () => {
  let receivedAgentId = 'unset';
  const flowsRepo = makeFlowsRepo({ topologyEdges: async ({ agentId }) => { receivedAgentId = agentId; return sampleEdges; } });
  const app = makeApp({ flowsRepo, agentsRepo: makeAgentsRepo({ findById: async (id) => ({ id }) }) });
  const res = await request(app).get('/api/topology?agentId=7').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(receivedAgentId, 7);
  assert.equal(res.body.agentId, 7);
});
