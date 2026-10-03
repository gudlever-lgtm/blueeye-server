'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// The three answers POST /agents/:id/update can give, and the two that are NOT
// refusals.
//
// The dashboard used to branch on `accepted` alone, so an agent that was offline
// (queued) and an agent that never acked (a half-open socket) both surfaced as
// "the agent refused the update — it gave no reason". The operator clicked
// Update again, the second click landed on a live socket, and the upgrade looked
// like something that needed two tries. These specs pin the shapes the UI reads.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeAgentCommander, makeAuditRepo, makeSourceStore, makeCommandQueue, authHeader,
} = require('../test-support/fakes');

const admin = () => authHeader('admin');
const viewer = () => authHeader('viewer');
const agent5 = () => makeAgentsRepo({ findById: async () => ({ id: 5, hostname: 'node-5' }) });
const source = () => makeSourceStore({ sourceVersion: () => '0.1.0' });

// Delivered on a socket the server still believes in, no ack inside the window.
const noAck = () => makeAgentCommander({
  sendCommandAndWait: async () => ({ delivered: 1, acked: false, reply: null, timedOut: true }),
});

test('a delivered update that is never acked says timedOut, not refused', async () => {
  const auditRepo = makeAuditRepo();
  const res = await request(makeApp({ agentsRepo: agent5(), agentCommander: noAck(), auditRepo, agentSourceStore: source() }))
    .post('/agents/5/update').set('Authorization', admin());

  assert.equal(res.status, 202);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.acked, false);
  assert.equal(res.body.accepted, false);
  assert.equal(res.body.timedOut, true);
  assert.equal(res.body.reason, null);
  // The command is out there and the agent may be rebuilding: the row stays open
  // for the agent to close, instead of being called a failure now.
  assert.equal(auditRepo.rows[0].state, 'requested');
  assert.equal(typeof res.body.auditId, 'number');
});

test('an accepted update is not flagged as timed out', async () => {
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async () => ({ delivered: 1, acked: true, reply: { accepted: true, runtime: 'systemd' } }),
  });
  const res = await request(makeApp({ agentsRepo: agent5(), agentCommander, agentSourceStore: source() }))
    .post('/agents/5/update').set('Authorization', admin());

  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, true);
  assert.equal(res.body.timedOut, false);
});

test('a declined runtime still reports its reason, with timedOut false', async () => {
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async () => ({ delivered: 1, acked: true, reply: { accepted: false, runtime: 'docker', reason: 'docker-managed' } }),
  });
  const res = await request(makeApp({ agentsRepo: agent5(), agentCommander, agentSourceStore: source() }))
    .post('/agents/5/update').set('Authorization', admin());

  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, false);
  assert.equal(res.body.timedOut, false);
  assert.equal(res.body.reason, 'docker-managed');
});

test('a queued update carries queued + the target version the UI shows', async () => {
  const agentCommander = makeAgentCommander({ sendCommandAndWait: async () => ({ delivered: 0, acked: false, reply: null }) });
  const res = await request(makeApp({
    agentsRepo: agent5(), agentCommander, agentCommandQueue: makeCommandQueue(), agentSourceStore: source(),
  })).post('/agents/5/update').set('Authorization', admin());

  assert.equal(res.status, 202);
  assert.equal(res.body.queued, true);
  assert.equal(res.body.connected, false);
  assert.equal(res.body.targetVersion, '0.1.0');
  assert.equal(typeof res.body.auditId, 'number');
});

test('an unknown agent is 404, not a queued update', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const res = await request(makeApp({ agentsRepo, agentCommander: noAck(), agentSourceStore: source() }))
    .post('/agents/404/update').set('Authorization', admin());
  assert.equal(res.status, 404);
});

test('a repository failure is a 500, not a silent 202', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => { throw new Error('db down'); } });
  const res = await request(makeApp({ agentsRepo, agentCommander: noAck(), agentSourceStore: source() }))
    .post('/agents/5/update').set('Authorization', admin());
  assert.equal(res.status, 500);
});

test('a viewer cannot ask for an update', async () => {
  const res = await request(makeApp({ agentsRepo: agent5(), agentCommander: noAck(), agentSourceStore: source() }))
    .post('/agents/5/update').set('Authorization', viewer());
  assert.equal(res.status, 403);
});
