'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const { makeApp, makeAgentTokensRepo, makeAgentsRepo } = require('../test-support/fakes');
const { attachAgentWebSocket } = require('../src/ws/agentSocket');

// Records agents.setStatus calls and lets a test await a particular status.
function makeStatusTracker() {
  const calls = [];
  const waiters = [];
  async function setStatus(id, status) {
    calls.push({ id, status });
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].status === status) {
        waiters[i].resolve({ id, status });
        waiters.splice(i, 1);
      }
    }
  }
  function waitFor(status) {
    const found = calls.find((c) => c.status === status);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => waiters.push({ status, resolve }));
  }
  return { setStatus, waitFor, calls };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `timeout after ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Boots an HTTP server with the agent WebSocket attached, runs fn, then cleans
// up regardless of outcome.
async function withWsServer({ agentTokensRepo, agentsRepo }, fn) {
  const app = makeApp({ agentTokensRepo, agentsRepo });
  const server = http.createServer(app);
  const handle = attachAgentWebSocket({ server, agentTokensRepo, agentsRepo });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    return await fn({ port, handle });
  } finally {
    handle.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function waitOpen(client) {
  return new Promise((resolve, reject) => {
    client.on('open', resolve);
    client.on('error', reject);
    client.on('unexpected-response', () => reject(new Error('unexpected-response')));
  });
}

const validRepo = () =>
  makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

test('WS connect succeeds with a valid token (header) and marks agent online', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
      headers: { Authorization: 'Bearer good' },
    });
    try {
      const firstMessage = await withTimeout(
        new Promise((resolve, reject) => {
          client.on('message', (data) => resolve(JSON.parse(data.toString())));
          client.on('error', reject);
          client.on('unexpected-response', () => reject(new Error('rejected')));
        }),
        4000,
        'no message received'
      );
      const online = await withTimeout(tracker.waitFor('online'), 4000, 'online not set');

      assert.equal(online.id, 9);
      assert.equal(firstMessage.type, 'connected');
      assert.equal(firstMessage.agentId, 9);
    } finally {
      client.close();
    }
  });
});

test('WS connect succeeds with a valid token via query parameter', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent?token=good`);
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      await withTimeout(tracker.waitFor('online'), 4000, 'online not set');
    } finally {
      client.close();
    }
  });
});

test('WS connect is rejected with an invalid token', async () => {
  const agentTokensRepo = makeAgentTokensRepo({ findActiveByHash: async () => null });

  await withWsServer({ agentTokensRepo, agentsRepo: makeAgentsRepo() }, async ({ port }) => {
    const outcome = await withTimeout(
      new Promise((resolve) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
          headers: { Authorization: 'Bearer bad' },
        });
        client.on('open', () => resolve('open'));
        client.on('unexpected-response', () => resolve('rejected'));
        client.on('error', () => resolve('rejected'));
      }),
      4000,
      'no outcome'
    );
    assert.notEqual(outcome, 'open');
  });
});

test('WS connect is rejected without a token', async () => {
  await withWsServer(
    { agentTokensRepo: makeAgentTokensRepo(), agentsRepo: makeAgentsRepo() },
    async ({ port }) => {
      const outcome = await withTimeout(
        new Promise((resolve) => {
          const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
          client.on('open', () => resolve('open'));
          client.on('unexpected-response', () => resolve('rejected'));
          client.on('error', () => resolve('rejected'));
        }),
        4000,
        'no outcome'
      );
      assert.notEqual(outcome, 'open');
    }
  );
});

test('WS disconnect marks the agent offline', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
      headers: { Authorization: 'Bearer good' },
    });
    await withTimeout(waitOpen(client), 4000, 'did not open');
    await withTimeout(tracker.waitFor('online'), 4000, 'online not set');
    client.close();
    await withTimeout(tracker.waitFor('offline'), 4000, 'offline not set');
  });
});

test('server can push a command to a connected agent', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ port, handle }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
      headers: { Authorization: 'Bearer good' },
    });
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      await withTimeout(tracker.waitFor('online'), 4000, 'online not set');

      const command = await withTimeout(
        new Promise((resolve) => {
          client.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'command') resolve(msg);
          });
          const sent = handle.sendCommand(9, { name: 'run-test' });
          assert.equal(sent, 1);
        }),
        4000,
        'no command received'
      );
      assert.equal(command.command.name, 'run-test');
    } finally {
      client.close();
    }
  });
});

test('sendCommandAndWait resolves when the agent acks with the command id', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ port, handle }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
      headers: { Authorization: 'Bearer good' },
    });
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      await withTimeout(tracker.waitFor('online'), 4000, 'online not set');
      // Agent side: echo the command id back in an ack frame.
      client.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'command') {
          client.send(JSON.stringify({ type: 'ack', id: msg.command.id, ok: true, agentVersion: '9.9.9' }));
        }
      });
      const out = await withTimeout(
        handle.sendCommandAndWait(9, { name: 'ping' }, { timeoutMs: 4000 }),
        4000,
        'no ack'
      );
      assert.equal(out.delivered, 1);
      assert.equal(out.acked, true);
      assert.equal(out.reply.agentVersion, '9.9.9');
    } finally {
      client.close();
    }
  });
});

test('sendCommandAndWait reports delivered:0 when the agent is not connected', async () => {
  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo: makeAgentsRepo() }, async ({ handle }) => {
    const out = await handle.sendCommandAndWait(12345, { name: 'ping' }, { timeoutMs: 200 });
    assert.equal(out.delivered, 0);
    assert.equal(out.acked, false);
  });
});

test('sendCommandAndWait times out when the agent never replies', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ port, handle }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
      headers: { Authorization: 'Bearer good' },
    });
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      await withTimeout(tracker.waitFor('online'), 4000, 'online not set');
      const out = await withTimeout(
        handle.sendCommandAndWait(9, { name: 'ping' }, { timeoutMs: 150 }),
        4000,
        'did not resolve'
      );
      assert.equal(out.delivered, 1);
      assert.equal(out.acked, false);
      assert.equal(out.timedOut, true);
    } finally {
      client.close();
    }
  });
});

test('records an agent-reported hsflowd status, exposed via getSflowStatus', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ port, handle }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent?token=good`);
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      await withTimeout(tracker.waitFor('online'), 4000, 'online not set');
      assert.equal(handle.getSflowStatus(9), null); // nothing reported yet

      client.send(JSON.stringify({ type: 'sflow.status', state: 'active', detail: 'ok' }));
      const status = await withTimeout((async () => {
        for (;;) {
          const s = handle.getSflowStatus(9);
          if (s) return s;
          await new Promise((r) => setTimeout(r, 20));
        }
      })(), 4000, 'status not recorded');

      assert.equal(status.state, 'active');
      assert.equal(status.detail, 'ok');
      assert.ok(status.at);
    } finally {
      client.close();
    }
  });
});

test('coerces an out-of-vocabulary hsflowd state to "unknown"', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ port, handle }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent?token=good`);
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      await withTimeout(tracker.waitFor('online'), 4000, 'online not set');
      client.send(JSON.stringify({ type: 'sflow.status', state: 'bogus', detail: 123 }));
      const status = await withTimeout((async () => {
        for (;;) {
          const s = handle.getSflowStatus(9);
          if (s) return s;
          await new Promise((r) => setTimeout(r, 20));
        }
      })(), 4000, 'status not recorded');
      assert.equal(status.state, 'unknown');
      assert.equal(status.detail, null);
    } finally {
      client.close();
    }
  });
});
