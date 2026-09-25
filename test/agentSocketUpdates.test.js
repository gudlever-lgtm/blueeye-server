'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// The socket's half of "an agent can always be updated": it hands over whatever
// was queued while the agent was away, and it answers an agent that asks for its
// own update — after re-checking everything the agent claimed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const {
  makeApp, makeAgentTokensRepo, makeAgentsRepo, makeCommandQueue, makeSourceStore, makeReleaseStore,
} = require('../test-support/fakes');
const { attachAgentWebSocket } = require('../src/ws/agentSocket');
const { createAgentUpdateService } = require('../src/services/agentUpdateService');

const validRepo = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `timeout after ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withWsServer(opts, fn) {
  const agentTokensRepo = validRepo();
  const agentsRepo = opts.agentsRepo || makeAgentsRepo();
  const app = makeApp({ agentTokensRepo, agentsRepo });
  const server = http.createServer(app);
  const handle = attachAgentWebSocket({ server, agentTokensRepo, agentsRepo, ...opts });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    return await fn({ port: server.address().port, handle });
  } finally {
    handle.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

// Collects frames until `match` sees one, then resolves with it.
function awaitFrame(client, match) {
  return new Promise((resolve, reject) => {
    client.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (match(msg)) resolve(msg);
    });
    client.on('error', reject);
    client.on('unexpected-response', () => reject(new Error('rejected')));
  });
}

const updateService = (version) => createAgentUpdateService({
  agentSourceStore: makeSourceStore({ sourceVersion: () => version, available: () => true }),
  releaseStore: makeReleaseStore({ latest: () => null }),
  logger: { info() {}, warn() {}, error() {} },
});

test('a command queued while the agent was away is delivered when it connects', async () => {
  const commandQueue = makeCommandQueue();
  await commandQueue.enqueue(9, { name: 'update', version: '1.0.0' }, { auditId: 42 });

  await withWsServer({ commandQueue }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    try {
      const frame = await withTimeout(awaitFrame(client, (m) => m.type === 'command'), 4000, 'no queued command arrived');
      assert.equal(frame.command.name, 'update');
      assert.equal(frame.command.version, '1.0.0');
      assert.equal(frame.command.auditId, 42, 'the outcome lands on the request that asked for it');
      assert.ok(frame.command.id, 'it carries a correlation id, stamped at delivery');
      // Claimed as it was read: a second socket must not deliver it again.
      assert.equal((await commandQueue.pendingFor(9)).length, 0);
    } finally {
      client.close();
    }
  });
});

test('a queued command is signed at delivery, not at enqueue time', async () => {
  // The agent refuses a signature more than five minutes off its clock, so the
  // signature has to be made now — which also means a stored row is not a
  // replayable credential.
  const commandQueue = makeCommandQueue();
  await commandQueue.enqueue(9, { name: 'update', version: '1.0.0' });
  const signed = [];

  await withWsServer({
    commandQueue,
    signCommand: (agentId, command) => { signed.push({ agentId, command }); return { ...command, commandSignature: 'sig' }; },
  }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    try {
      const frame = await withTimeout(awaitFrame(client, (m) => m.type === 'command'), 4000, 'no queued command arrived');
      assert.equal(frame.command.commandSignature, 'sig');
      assert.equal(signed.length, 1);
    } finally {
      client.close();
    }
  });
});

test('an agent that is behind gets the update it asks for', async () => {
  await withWsServer({
    updateService: updateService('1.0.0'),
    agentUpdatePolicy: async () => ({ autoUpdate: true }),
  }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    try {
      await withTimeout(awaitFrame(client, (m) => m.type === 'connected'), 4000, 'never connected');
      const command = awaitFrame(client, (m) => m.type === 'command');
      client.send(JSON.stringify({ type: 'update-request', currentVersion: '0.9.0' }));
      const frame = await withTimeout(command, 4000, 'no update was sent');
      assert.equal(frame.command.name, 'update');
      assert.equal(frame.command.version, '1.0.0');
    } finally {
      client.close();
    }
  });
});

test('the agent is not taken at its word: policy off, not behind, and cooldown all refuse', async () => {
  const cases = [
    { name: 'auto-update-disabled', policy: async () => ({ autoUpdate: false }), currentVersion: '0.9.0' },
    { name: 'not-behind', policy: async () => ({ autoUpdate: true }), currentVersion: '1.0.0' },
    { name: 'not-behind', policy: async () => ({ autoUpdate: true }), currentVersion: '' },
  ];
  for (const testCase of cases) {
    // eslint-disable-next-line no-await-in-loop
    await withWsServer({
      updateService: updateService('1.0.0'),
      agentUpdatePolicy: testCase.policy,
    }, async ({ port }) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
      try {
        await withTimeout(awaitFrame(client, (m) => m.type === 'connected'), 4000, 'never connected');
        const reply = awaitFrame(client, (m) => m.type === 'update-request-result');
        client.send(JSON.stringify({ type: 'update-request', currentVersion: testCase.currentVersion }));
        const frame = await withTimeout(reply, 4000, 'no answer to the request');
        assert.equal(frame.accepted, false);
        assert.equal(frame.reason, testCase.name);
      } finally {
        client.close();
      }
    });
  }
});

test('a second request inside the cooldown is refused, so a reconnect loop is not an update loop', async () => {
  await withWsServer({
    updateService: updateService('1.0.0'),
    agentUpdatePolicy: async () => ({ autoUpdate: true }),
  }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    try {
      await withTimeout(awaitFrame(client, (m) => m.type === 'connected'), 4000, 'never connected');
      const first = awaitFrame(client, (m) => m.type === 'update-request-result');
      client.send(JSON.stringify({ type: 'update-request', currentVersion: '0.9.0' }));
      assert.equal((await withTimeout(first, 4000, 'no first answer')).accepted, true);

      const second = awaitFrame(client, (m) => m.type === 'update-request-result' && m.accepted === false);
      client.send(JSON.stringify({ type: 'update-request', currentVersion: '0.9.0' }));
      assert.equal((await withTimeout(second, 4000, 'no second answer')).reason, 'cooldown');
    } finally {
      client.close();
    }
  });
});

test('without an update service the frame is ignored rather than crashing the hub', async () => {
  await withWsServer({}, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    try {
      await withTimeout(awaitFrame(client, (m) => m.type === 'connected'), 4000, 'never connected');
      client.send(JSON.stringify({ type: 'update-request', currentVersion: '0.9.0' }));
      client.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(client.readyState, WebSocket.OPEN, 'the socket is still up');
    } finally {
      client.close();
    }
  });
});
