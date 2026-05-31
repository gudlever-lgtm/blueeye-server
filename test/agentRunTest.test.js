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
  authHeader,
} = require('../test-support/fakes');

const operator = () => authHeader('operator');

test('POST /agents/:id/run-test pushes a run-test command (operator) -> 202', async () => {
  let sent;
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9, hostname: 'node-01' }) });
  const agentCommander = makeAgentCommander({
    sendCommand: (id, command) => {
      sent = { id, command };
      return 1;
    },
  });

  const res = await request(makeApp({ agentsRepo, agentCommander }))
    .post('/agents/9/run-test')
    .set('Authorization', operator())
    .send({ intervalMs: 500 });

  assert.equal(res.status, 202);
  assert.equal(res.body.delivered, 1);
  assert.equal(sent.id, 9);
  assert.equal(sent.command.name, 'run-test');
  assert.equal(sent.command.intervalMs, 500);
});

test('POST /agents/:id/run-test returns 409 when the agent is not connected', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9 }) });
  const agentCommander = makeAgentCommander({ sendCommand: () => 0 });

  const res = await request(makeApp({ agentsRepo, agentCommander }))
    .post('/agents/9/run-test')
    .set('Authorization', operator());

  assert.equal(res.status, 409);
  assert.equal(res.body.delivered, 0);
});

test('POST /agents/:id/run-test returns 404 when the agent does not exist', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const res = await request(makeApp({ agentsRepo }))
    .post('/agents/999/run-test')
    .set('Authorization', operator());
  assert.equal(res.status, 404);
});

test('POST /agents/:id/run-test returns 400 for an invalid id', async () => {
  const res = await request(makeApp()).post('/agents/abc/run-test').set('Authorization', operator());
  assert.equal(res.status, 400);
});

test('POST /agents/:id/run-test is forbidden for a viewer (403)', async () => {
  const res = await request(makeApp())
    .post('/agents/9/run-test')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('POST /agents/:id/run-test without a token returns 401', async () => {
  const res = await request(makeApp()).post('/agents/9/run-test');
  assert.equal(res.status, 401);
});
