'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentTokensRepo, makeProbeResultsRepo, makeIncidentService } = require('../test-support/fakes');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

test('probe-results ingest triggers incident derivation for the agent', async () => {
  const incidentService = makeIncidentService();
  const probeResultsRepo = makeProbeResultsRepo();
  const res = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo, incidentService }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [{ type: 'ping', target: '1.1.1.1', ok: false }] });
  assert.equal(res.status, 201);
  assert.deepEqual(incidentService.calls, [{ agentId: 9 }]);
});

test('a failing incident service never breaks probe ingestion (still 201)', async () => {
  const incidentService = makeIncidentService({ processAgent: async () => { throw new Error('boom'); } });
  const res = await request(makeApp({ agentTokensRepo: agentToken(), incidentService }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [{ type: 'ping', target: '1.1.1.1', ok: false }] });
  assert.equal(res.status, 201);
});
