'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentTokensRepo,
  makeAgentsRepo,
  makeResultsRepo,
} = require('../test-support/fakes');

const tokenRecord = { id: 1, agent_id: 9 };
const validBody = { results: [{ test: 'ping', ok: true }] };

function baseDeps(extra = {}) {
  return {
    agentTokensRepo: makeAgentTokensRepo({
      findActiveByHash: async () => tokenRecord,
      touchLastUsed: async () => {},
    }),
    agentsRepo: makeAgentsRepo({ touchLastSeen: async () => {} }),
    resultsRepo: makeResultsRepo({ createMany: async (_a, p) => p.length }),
    ...extra,
  };
}

test('POST /agents/results mirrors results into the TSDB when enabled', async () => {
  let mirrored;
  const resultsTsdbRepo = { createMany: async (agentId, payloads) => { mirrored = { agentId, payloads }; return payloads.length; } };

  const res = await request(makeApp(baseDeps({ resultsTsdbRepo })))
    .post('/agents/results')
    .set('Authorization', 'Bearer good')
    .send(validBody);

  assert.equal(res.status, 201);
  assert.deepEqual(mirrored, { agentId: 9, payloads: validBody.results });
});

test('POST /agents/results still succeeds (201) when the TSDB mirror write fails', async () => {
  const resultsTsdbRepo = {
    createMany: async () => { throw new Error('TSDB down'); },
  };

  const res = await request(makeApp(baseDeps({ resultsTsdbRepo })))
    .post('/agents/results')
    .set('Authorization', 'Bearer good')
    .send(validBody);

  // MySQL is the source of truth; a TSDB failure must never break ingest.
  assert.equal(res.status, 201);
});

test('POST /agents/results behaves exactly as before when TSDB is disabled (no mirror)', async () => {
  const res = await request(makeApp(baseDeps())) // resultsTsdbRepo null
    .post('/agents/results')
    .set('Authorization', 'Bearer good')
    .send(validBody);

  assert.equal(res.status, 201);
});

test('POST /agents/results with invalid body returns 400 and never mirrors', async () => {
  let mirrorCalled = false;
  const resultsTsdbRepo = { createMany: async () => { mirrorCalled = true; return 0; } };

  const res = await request(makeApp(baseDeps({ resultsTsdbRepo })))
    .post('/agents/results')
    .set('Authorization', 'Bearer good')
    .send({ results: 'not-an-array' });

  assert.equal(res.status, 400);
  assert.equal(mirrorCalled, false);
});
