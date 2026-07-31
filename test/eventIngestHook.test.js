'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentTokensRepo, makeProbeResultsRepo, makeProbeOutageService } = require('../test-support/fakes');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

test('probe-results ingest triggers event derivation for the agent', async () => {
  const probeOutageService = makeProbeOutageService();
  const probeResultsRepo = makeProbeResultsRepo();
  const res = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo, probeOutageService }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [{ type: 'ping', target: '1.1.1.1', ok: false }] });
  assert.equal(res.status, 201);
  assert.deepEqual(probeOutageService.calls, [{ agentId: 9 }]);
});

test('a failing event service never breaks probe ingestion (still 201)', async () => {
  const probeOutageService = makeProbeOutageService({ processAgent: async () => { throw new Error('boom'); } });
  const res = await request(makeApp({ agentTokensRepo: agentToken(), probeOutageService }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [{ type: 'ping', target: '1.1.1.1', ok: false }] });
  assert.equal(res.status, 201);
});
