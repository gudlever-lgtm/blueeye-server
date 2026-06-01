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
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

// A token record as returned by agent_tokens lookup (agent_id 9).
const tokenRecord = { id: 1, agent_id: 9 };
const validBody = { results: [{ test: 'ping', ok: true }, { test: 'disk', ok: false }] };

// ----------------------------------------- POST /agents/results (agent token)
test('POST /agents/results without a token returns 401', async () => {
  const res = await request(makeApp()).post('/agents/results').send(validBody);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Agent authentication required');
});

test('POST /agents/results with an invalid token returns 401', async () => {
  const agentTokensRepo = makeAgentTokensRepo({ findActiveByHash: async () => null });
  const res = await request(makeApp({ agentTokensRepo }))
    .post('/agents/results')
    .set('Authorization', 'Bearer nope')
    .send(validBody);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid agent token');
});

test('POST /agents/results with a valid token stores results and returns 201', async () => {
  let createArgs;
  let touchedToken;
  let touchedSeen;
  const agentTokensRepo = makeAgentTokensRepo({
    findActiveByHash: async () => tokenRecord,
    touchLastUsed: async (id) => { touchedToken = id; },
  });
  const agentsRepo = makeAgentsRepo({ touchLastSeen: async (id) => { touchedSeen = id; } });
  const resultsRepo = makeResultsRepo({
    createMany: async (agentId, payloads) => {
      createArgs = { agentId, payloads };
      return payloads.length;
    },
  });

  const res = await request(makeApp({ agentTokensRepo, agentsRepo, resultsRepo }))
    .post('/agents/results')
    .set('Authorization', 'Bearer good')
    .send(validBody);

  assert.equal(res.status, 201);
  assert.equal(res.body.inserted, 2);
  assert.equal(createArgs.agentId, 9); // agent_id comes from the token
  assert.equal(createArgs.payloads.length, 2);
  // Liveness bookkeeping happened.
  assert.equal(touchedToken, 1);
  assert.equal(touchedSeen, 9);
});

test('POST /agents/results with an invalid body returns 400', async () => {
  const agentTokensRepo = makeAgentTokensRepo({ findActiveByHash: async () => tokenRecord });
  const res = await request(makeApp({ agentTokensRepo }))
    .post('/agents/results')
    .set('Authorization', 'Bearer good')
    .send({ results: 'not-an-array' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('POST /agents/results returns 500 when the results repo throws', async () => {
  const agentTokensRepo = makeAgentTokensRepo({ findActiveByHash: async () => tokenRecord });
  const resultsRepo = makeResultsRepo({ createMany: throwingAsync() });
  const res = await request(makeApp({ agentTokensRepo, resultsRepo }))
    .post('/agents/results')
    .set('Authorization', 'Bearer good')
    .send(validBody);
  assert.equal(res.status, 500);
});

test('POST /agents/results returns 500 when the token lookup throws', async () => {
  const agentTokensRepo = makeAgentTokensRepo({ findActiveByHash: throwingAsync() });
  const res = await request(makeApp({ agentTokensRepo }))
    .post('/agents/results')
    .set('Authorization', 'Bearer good')
    .send(validBody);
  assert.equal(res.status, 500);
});

// ----------------------------------- GET /agents/:id/results (user JWT, viewer+)
test('GET /agents/:id/results returns 200 (viewer)', async () => {
  const rows = [{ id: 1, agent_id: 9, payload: { ok: true }, created_at: 'x' }];
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9, hostname: 'h' }) });
  const resultsRepo = makeResultsRepo({ findByAgentId: async () => rows });

  const res = await request(makeApp({ agentsRepo, resultsRepo }))
    .get('/agents/9/results')
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, rows);
});

test('GET /agents/:id/results passes a parsed time range to the repo', async () => {
  let received;
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9, hostname: 'h' }) });
  const resultsRepo = makeResultsRepo({
    findByAgentId: async (id, range) => { received = { id, range }; return []; },
  });
  const res = await request(makeApp({ agentsRepo, resultsRepo }))
    .get('/agents/9/results?from=2026-05-01T00:00:00Z&to=2026-05-31T00:00:00Z&limit=50')
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.equal(received.id, 9);
  assert.ok(received.range.from instanceof Date && received.range.to instanceof Date);
  assert.equal(received.range.limit, 50);
});

test('GET /agents/:id/results returns 400 for an invalid date range', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9 }) });
  const res = await request(makeApp({ agentsRepo }))
    .get('/agents/9/results?from=garbage')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /agents/:id/results returns 404 when the agent does not exist', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const res = await request(makeApp({ agentsRepo }))
    .get('/agents/999/results')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Agent not found');
});

test('GET /agents/:id/results returns 400 for an invalid id', async () => {
  const res = await request(makeApp())
    .get('/agents/abc/results')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /agents/:id/results without a token returns 401', async () => {
  const res = await request(makeApp()).get('/agents/9/results');
  assert.equal(res.status, 401);
});

test('GET /agents/:id/results returns 500 when the repo throws', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9 }) });
  const resultsRepo = makeResultsRepo({ findByAgentId: throwingAsync() });
  const res = await request(makeApp({ agentsRepo, resultsRepo }))
    .get('/agents/9/results')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

// ------------------------------------------- GET /agents/:id/flows (netflow) ---
const flowRows = [
  { id: 2, agent_id: 9, created_at: '2026-05-31T10:01:00.000Z', payload: { traffic: {
    byPort: [{ port: 443, bytes: 2000, packets: 20, flows: 4 }, { port: 53, bytes: 300, packets: 3, flows: 2 }],
    byProtocol: [{ protocol: 'tcp', bytes: 2000, packets: 20, flows: 4 }, { protocol: 'udp', bytes: 300, packets: 3, flows: 2 }],
  } } },
  { id: 1, agent_id: 9, created_at: '2026-05-31T10:00:00.000Z', payload: { traffic: {
    byPort: [{ port: 443, bytes: 1000, packets: 10, flows: 2 }],
    byProtocol: [{ protocol: 'tcp', bytes: 1000, packets: 10, flows: 2 }],
  } } },
];

test('GET /agents/:id/flows aggregates byPort/byProtocol across measurements', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9, hostname: 'h' }) });
  const resultsRepo = makeResultsRepo({ findByAgentId: async () => flowRows });
  const res = await request(makeApp({ agentsRepo, resultsRepo }))
    .get('/agents/9/flows')
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  const p443 = res.body.byPort.find((p) => p.port === 443);
  assert.equal(p443.bytes, 3000); // 2000 + 1000
  assert.equal(res.body.byPort[0].port, 443); // sorted by bytes desc
  const tcp = res.body.byProtocol.find((p) => p.protocol === 'tcp');
  assert.equal(tcp.bytes, 3000);
});

test('GET /agents/:id/flows?port=443 filters to one port with a time series', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9 }) });
  const resultsRepo = makeResultsRepo({ findByAgentId: async () => flowRows });
  const res = await request(makeApp({ agentsRepo, resultsRepo }))
    .get('/agents/9/flows?port=443')
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.equal(res.body.filter.port, 443);
  assert.equal(res.body.byPort.length, 1);
  assert.equal(res.body.byPort[0].bytes, 3000);
  // Series has one point per measurement (oldest first).
  assert.equal(res.body.series.length, 2);
  assert.equal(res.body.series[0].bytes, 1000);
  assert.equal(res.body.series[1].bytes, 2000);
});

test('GET /agents/:id/flows?protocol=udp filters by protocol', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9 }) });
  const resultsRepo = makeResultsRepo({ findByAgentId: async () => flowRows });
  const res = await request(makeApp({ agentsRepo, resultsRepo }))
    .get('/agents/9/flows?protocol=udp')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.byProtocol.length, 1);
  assert.equal(res.body.byProtocol[0].protocol, 'udp');
  assert.equal(res.body.byProtocol[0].bytes, 300);
});

test('GET /agents/:id/flows returns 400 for a non-numeric port', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9 }) });
  const res = await request(makeApp({ agentsRepo }))
    .get('/agents/9/flows?port=https')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /agents/:id/flows returns 404 when the agent is missing', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const res = await request(makeApp({ agentsRepo }))
    .get('/agents/999/flows')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /agents/:id/flows without a token returns 401', async () => {
  const res = await request(makeApp()).get('/agents/9/flows');
  assert.equal(res.status, 401);
});
