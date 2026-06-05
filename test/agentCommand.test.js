'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentCommander,
  makeSourceStore,
  authHeader,
} = require('../test-support/fakes');

const viewer = () => authHeader('viewer');
const operator = () => authHeader('operator');
const admin = () => authHeader('admin');

// ---- POST /agents/:id/ping (liveness round-trip) ---------------------------

test('POST /agents/:id/ping round-trips to the agent and reports the reply (viewer+)', async () => {
  let asked;
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 7, hostname: 'node-7' }) });
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async (id, command) => {
      asked = { id, command };
      return { delivered: 1, acked: true, reply: { agentVersion: '0.1.0', sources: ['proc', 'netflow'], managed: 'systemd' } };
    },
  });

  const res = await request(makeApp({ agentsRepo, agentCommander }))
    .post('/agents/7/ping')
    .set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.acked, true);
  assert.equal(res.body.agentVersion, '0.1.0');
  assert.deepEqual(res.body.sources, ['proc', 'netflow']);
  assert.equal(res.body.managed, 'systemd');
  assert.equal(typeof res.body.latencyMs, 'number');
  assert.equal(asked.id, 7);
  assert.equal(asked.command.name, 'ping');
});

test('POST /agents/:id/ping returns 409 when the agent is not connected', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 7 }) });
  const agentCommander = makeAgentCommander({ sendCommandAndWait: async () => ({ delivered: 0, acked: false, reply: null }) });
  const res = await request(makeApp({ agentsRepo, agentCommander }))
    .post('/agents/7/ping')
    .set('Authorization', viewer());
  assert.equal(res.status, 409);
  assert.equal(res.body.connected, false);
});

test('POST /agents/:id/ping reports a timeout (connected but no reply)', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 7 }) });
  const agentCommander = makeAgentCommander({ sendCommandAndWait: async () => ({ delivered: 1, acked: false, reply: null, timedOut: true }) });
  const res = await request(makeApp({ agentsRepo, agentCommander }))
    .post('/agents/7/ping')
    .set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.acked, false);
  assert.equal(res.body.timedOut, true);
});

test('POST /agents/:id/ping returns 404 for an unknown agent', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const res = await request(makeApp({ agentsRepo })).post('/agents/999/ping').set('Authorization', viewer());
  assert.equal(res.status, 404);
});

test('POST /agents/:id/ping returns 400 for an invalid id', async () => {
  const res = await request(makeApp()).post('/agents/abc/ping').set('Authorization', viewer());
  assert.equal(res.status, 400);
});

test('POST /agents/:id/ping without a token returns 401', async () => {
  const res = await request(makeApp()).post('/agents/7/ping');
  assert.equal(res.status, 401);
});

// ---- POST /agents/:id/update (push self-update) -----------------------------

test('POST /agents/:id/update sends the bundle SHA and reports acceptance (admin)', async () => {
  let asked;
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 5, hostname: 'node-5' }) });
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async (id, command) => {
      asked = { id, command };
      return { delivered: 1, acked: true, reply: { accepted: true, runtime: 'systemd' } };
    },
  });
  const agentSourceStore = makeSourceStore({ sha256: 'd'.repeat(64) });

  const res = await request(makeApp({ agentsRepo, agentCommander, agentSourceStore }))
    .post('/agents/5/update')
    .set('Authorization', admin());

  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, true);
  assert.equal(res.body.runtime, 'systemd');
  assert.equal(res.body.targetVersion, '0.1.0');
  assert.equal(asked.command.name, 'update');
  assert.equal(asked.command.sha256, 'd'.repeat(64));
});

test('POST /agents/:id/update reports a Docker agent declining', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 5 }) });
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async () => ({ delivered: 1, acked: true, reply: { accepted: false, runtime: 'docker', reason: 'docker-managed' } }),
  });
  const res = await request(makeApp({ agentsRepo, agentCommander }))
    .post('/agents/5/update')
    .set('Authorization', admin());
  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, false);
  assert.equal(res.body.reason, 'docker-managed');
});

test('POST /agents/:id/update returns 409 when the agent is not connected', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 5 }) });
  const agentCommander = makeAgentCommander({ sendCommandAndWait: async () => ({ delivered: 0, acked: false, reply: null }) });
  const res = await request(makeApp({ agentsRepo, agentCommander }))
    .post('/agents/5/update')
    .set('Authorization', admin());
  assert.equal(res.status, 409);
});

test('POST /agents/:id/update returns 503 when the server has no source published', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 5 }) });
  const res = await request(makeApp({ agentsRepo, agentSourceStore: makeSourceStore({ present: false }) }))
    .post('/agents/5/update')
    .set('Authorization', admin());
  assert.equal(res.status, 503);
});

test('POST /agents/:id/update returns 404 for an unknown agent', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const res = await request(makeApp({ agentsRepo })).post('/agents/999/update').set('Authorization', admin());
  assert.equal(res.status, 404);
});

test('POST /agents/:id/update is forbidden for an operator (403)', async () => {
  const res = await request(makeApp()).post('/agents/5/update').set('Authorization', operator());
  assert.equal(res.status, 403);
});

test('POST /agents/:id/update without a token returns 401', async () => {
  const res = await request(makeApp()).post('/agents/5/update');
  assert.equal(res.status, 401);
});
