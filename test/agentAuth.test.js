'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
} = require('../test-support/fakes');

const tokenRecord = { id: 1, agent_id: 9 };
const validBody = { results: [{ test: 'ping', ok: true }] };

// ── 401 — missing / invalid token ───────────────────────────────────────────

test('no Authorization header → 401 "Agent authentication required"', async () => {
  const res = await request(makeApp()).post('/agents/results').send(validBody);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Agent authentication required');
});

test('wrong scheme (Basic instead of Bearer) → 401', async () => {
  const res = await request(makeApp())
    .post('/agents/results')
    .set('Authorization', 'Basic dXNlcjpwYXNz')
    .send(validBody);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Agent authentication required');
});

test('valid Authorization header but token not in DB → 401 "Invalid agent token"', async () => {
  const agentTokensRepo = makeAgentTokensRepo({ findActiveByHash: async () => null });
  const res = await request(makeApp({ agentTokensRepo }))
    .post('/agents/results')
    .set('Authorization', 'Bearer unknown-token')
    .send(validBody);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid agent token');
});

test('token row with null agent_id → 401 "Invalid agent token"', async () => {
  const agentTokensRepo = makeAgentTokensRepo({
    findActiveByHash: async () => ({ id: 1, agent_id: null }),
  });
  const res = await request(makeApp({ agentTokensRepo }))
    .post('/agents/results')
    .set('Authorization', 'Bearer orphan-token')
    .send(validBody);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid agent token');
});

// ── throttle — max 1 liveness write per 30 s per agent_id ──────────────────

test('100 rapid requests from the same agent_id call touchLastSeen at most once', async () => {
  let touchSeenCount = 0;
  let touchUsedCount = 0;
  const agentTokensRepo = makeAgentTokensRepo({
    findActiveByHash: async () => tokenRecord,
    touchLastUsed: async () => { touchUsedCount++; },
  });
  const agentsRepo = makeAgentsRepo({
    touchLastSeen: async () => { touchSeenCount++; },
  });
  // Single app instance → single shared throttle Map across all requests.
  const app = makeApp({ agentTokensRepo, agentsRepo });
  await Promise.all(
    Array.from({ length: 100 }, () =>
      request(app)
        .post('/agents/results')
        .set('Authorization', 'Bearer good')
        .send(validBody),
    ),
  );
  assert.equal(touchSeenCount, 1, 'touchLastSeen called more than once within throttle window');
  assert.equal(touchUsedCount, 1, 'touchLastUsed called more than once within throttle window');
});

test('first request from a new agent_id always triggers a liveness write', async () => {
  let touchSeenCount = 0;
  let call = 0;
  // Alternate between two different agents across two sequential requests.
  const agentTokensRepo = makeAgentTokensRepo({
    findActiveByHash: async () => (call++ === 0
      ? { id: 1, agent_id: 9 }
      : { id: 2, agent_id: 10 }),
    touchLastUsed: async () => {},
  });
  const agentsRepo = makeAgentsRepo({
    touchLastSeen: async () => { touchSeenCount++; },
  });
  const app = makeApp({ agentTokensRepo, agentsRepo });
  // Sequential so the two agentIds are distinct in the Map.
  await request(app).post('/agents/results').set('Authorization', 'Bearer a').send(validBody);
  await request(app).post('/agents/results').set('Authorization', 'Bearer b').send(validBody);
  assert.equal(touchSeenCount, 2, 'Expected one touch per unique agentId');
});

// ── DB failure during liveness touch ─────────────────────────────────────────

test('touchLastSeen/touchLastUsed throw → request still returns 201 (best-effort)', async () => {
  const agentTokensRepo = makeAgentTokensRepo({
    findActiveByHash: async () => tokenRecord,
    touchLastUsed: async () => { throw new Error('DB down'); },
  });
  const agentsRepo = makeAgentsRepo({
    touchLastSeen: async () => { throw new Error('DB down'); },
  });
  const res = await request(makeApp({ agentTokensRepo, agentsRepo }))
    .post('/agents/results')
    .set('Authorization', 'Bearer good')
    .send(validBody);
  assert.equal(res.status, 201);
});

// ── 500 — token lookup failure ───────────────────────────────────────────────

test('DB failure during token lookup → 500', async () => {
  const agentTokensRepo = makeAgentTokensRepo({
    findActiveByHash: async () => { throw new Error('DB unreachable'); },
  });
  const res = await request(makeApp({ agentTokensRepo }))
    .post('/agents/results')
    .set('Authorization', 'Bearer good')
    .send(validBody);
  assert.equal(res.status, 500);
});
