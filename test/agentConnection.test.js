'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeAgentCommander, authHeader } = require('../test-support/fakes');

const viewer = () => authHeader('viewer');
const operator = () => authHeader('operator');

const agentsRepo = () =>
  makeAgentsRepo({ findById: async () => ({ id: 9, hostname: 'node-01', status: 'offline', last_seen: new Date().toISOString() }) });

const disconnectedInfo = (extra = {}) => ({
  connected: false,
  sockets: 0,
  session: null,
  licenseRejectedAt: null,
  authFailures: [],
  licenseAcceptsNew: true,
  ...extra,
});

// ---------- GET /agents/:id/connection ----------

test('GET /agents/:id/connection returns the diagnosis for a connected agent (viewer)', async () => {
  const res = await request(makeApp({ agentsRepo: agentsRepo() }))
    .get('/agents/9/connection')
    .set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.equal(res.body.agentId, 9);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.state, 'connected');
  assert.ok(res.body.explanation.length > 0);
  assert.ok(Array.isArray(res.body.evidence));
  assert.ok(Array.isArray(res.body.hints));
});

test('GET /agents/:id/connection explains a license-blocked agent', async () => {
  const agentCommander = makeAgentCommander({
    getConnectionInfo: () => disconnectedInfo({ licenseRejectedAt: new Date().toISOString(), licenseAcceptsNew: false }),
  });
  const res = await request(makeApp({ agentsRepo: agentsRepo(), agentCommander }))
    .get('/agents/9/connection')
    .set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.equal(res.body.connected, false);
  assert.equal(res.body.state, 'license-blocked');
  assert.match(res.body.explanation, /license/i);
});

test('GET /agents/:id/connection still answers when the WS hub is not available', async () => {
  const agentCommander = { sendCommand: () => 0 }; // no getConnectionInfo
  const res = await request(makeApp({ agentsRepo: agentsRepo(), agentCommander }))
    .get('/agents/9/connection')
    .set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.equal(res.body.connected, false);
  assert.ok(res.body.explanation.length > 0);
});

test('GET /agents/:id/connection -> 404 unknown agent, 400 bad id, 401 no token', async () => {
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findById: async () => null }) });
  assert.equal((await request(app).get('/agents/999/connection').set('Authorization', viewer())).status, 404);
  assert.equal((await request(app).get('/agents/abc/connection').set('Authorization', viewer())).status, 400);
  assert.equal((await request(app).get('/agents/9/connection')).status, 401);
});

// ---------- POST /agents/:id/reconnect ----------

test('POST /agents/:id/reconnect closes the socket and confirms the agent came back (operator)', async () => {
  let disconnectedId = null;
  let closed = false;
  const agentCommander = makeAgentCommander({
    // Connected before the forced close; connected again on the first re-poll.
    getConnectionInfo: () => (closed
      ? { ...disconnectedInfo(), connected: true, sockets: 1 }
      : { ...disconnectedInfo(), connected: true, sockets: 1 }),
    disconnectAgent: (id) => { disconnectedId = id; closed = true; return 1; },
  });

  const res = await request(makeApp({ agentsRepo: agentsRepo(), agentCommander }))
    .post('/agents/9/reconnect')
    .set('Authorization', operator());

  assert.equal(res.status, 200);
  assert.equal(disconnectedId, 9);
  assert.equal(res.body.closed, 1);
  assert.equal(res.body.reconnected, true);
  assert.equal(res.body.connected, true);
});

test('POST /agents/:id/reconnect reports reconnected:false when the agent does not come back', async () => {
  let closed = false;
  const agentCommander = makeAgentCommander({
    getConnectionInfo: () => (closed ? disconnectedInfo() : { ...disconnectedInfo(), connected: true, sockets: 1 }),
    disconnectAgent: () => { closed = true; return 1; },
  });

  // makeApp wires a short reconnect wait (200 ms / 10 ms poll) so this is fast.
  const res = await request(makeApp({ agentsRepo: agentsRepo(), agentCommander }))
    .post('/agents/9/reconnect')
    .set('Authorization', operator());

  assert.equal(res.status, 200);
  assert.equal(res.body.closed, 1);
  assert.equal(res.body.reconnected, false);
});

test('POST /agents/:id/reconnect -> 409 with the diagnosis when the agent is not connected', async () => {
  const agentCommander = makeAgentCommander({ getConnectionInfo: () => disconnectedInfo() });

  const res = await request(makeApp({ agentsRepo: agentsRepo(), agentCommander }))
    .post('/agents/9/reconnect')
    .set('Authorization', operator());

  assert.equal(res.status, 409);
  assert.equal(res.body.connected, false);
  // The 409 explains WHY it can't reconnect — the diagnosis rides along.
  assert.ok(res.body.diagnosis);
  assert.ok(res.body.diagnosis.explanation.length > 0);
  assert.notEqual(res.body.diagnosis.state, 'connected');
});

test('POST /agents/:id/reconnect -> 503 when the agent channel lacks the capability', async () => {
  const res = await request(makeApp({ agentsRepo: agentsRepo(), agentCommander: { sendCommand: () => 0 } }))
    .post('/agents/9/reconnect')
    .set('Authorization', operator());
  assert.equal(res.status, 503);
});

test('POST /agents/:id/reconnect -> 404 unknown, 400 bad id, 403 viewer, 401 anonymous', async () => {
  const missing = makeApp({ agentsRepo: makeAgentsRepo({ findById: async () => null }) });
  assert.equal((await request(missing).post('/agents/999/reconnect').set('Authorization', operator())).status, 404);
  const app = makeApp({ agentsRepo: agentsRepo() });
  assert.equal((await request(app).post('/agents/abc/reconnect').set('Authorization', operator())).status, 400);
  assert.equal((await request(app).post('/agents/9/reconnect').set('Authorization', viewer())).status, 403);
  assert.equal((await request(app).post('/agents/9/reconnect')).status, 401);
});
