'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFlowPipeline, makeAgentTokensRepo } = require('../test-support/fakes');

const agentTok = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

test('ingest runs the flow pipeline with the agent id and results', async () => {
  const flowPipeline = makeFlowPipeline();
  const app = makeApp({ agentTokensRepo: agentTok(), flowPipeline });
  const res = await request(app).post('/agents/results').set('Authorization', 'Bearer t')
    .send({ results: [{ traffic: { flows: [{ srcIp: '10.0.0.5', dstIp: '8.8.8.8', bytes: 100 }] } }] });

  assert.equal(res.status, 201);
  assert.equal(flowPipeline.calls.length, 1);
  assert.equal(flowPipeline.calls[0].agentId, 9);
  assert.equal(flowPipeline.calls[0].payloads.length, 1);
});

test('ingest still succeeds (no 500) when the flow pipeline throws', async () => {
  const flowPipeline = makeFlowPipeline({ processResults: async () => { throw new Error('boom'); } });
  const app = makeApp({ agentTokensRepo: agentTok(), flowPipeline });
  const res = await request(app).post('/agents/results').set('Authorization', 'Bearer t')
    .send({ results: [{ traffic: { flows: [{ srcIp: '10.0.0.5', dstIp: '8.8.8.8' }] } }] });
  assert.equal(res.status, 201); // flow enrichment is best-effort
});
