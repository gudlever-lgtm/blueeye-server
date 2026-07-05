'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const { makeApp, makeAgentTokensRepo, makeAgentsRepo } = require('../test-support/fakes');
const { attachAgentWebSocket } = require('../src/ws/agentSocket');
const { PROTOCOL_VERSION } = require('../src/protocol');

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
async function withWsServer({ agentTokensRepo, agentsRepo, auditRepo, auditEventsRepo, notifyDashboard, licenseGuard }, fn) {
  const app = makeApp({ agentTokensRepo, agentsRepo });
  const server = http.createServer(app);
  const handle = attachAgentWebSocket({ server, agentTokensRepo, agentsRepo, auditRepo, auditEventsRepo, notifyDashboard, ...(licenseGuard ? { licenseGuard } : {}) });
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
      // The connected frame echoes the server's wire-contract version.
      assert.equal(firstMessage.protocolVersion, PROTOCOL_VERSION);
    } finally {
      client.close();
    }
  });
});

test('WS connect tolerates a mismatched protocol version (warn, not fatal)', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
      headers: { Authorization: 'Bearer good', 'X-BlueEye-Protocol': '999' },
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
      // Still connects despite the version mismatch (backward-compatible).
      assert.equal(firstMessage.type, 'connected');
      assert.equal(firstMessage.protocolVersion, PROTOCOL_VERSION);
      await withTimeout(tracker.waitFor('online'), 4000, 'online not set');
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

test('an upgrade action-result completes the audit row', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const completed = [];
  const auditRepo = { complete: async (id, opts) => { completed.push({ id, ...opts }); resolveDone(); return true; } };

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo, auditRepo }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      client.send(JSON.stringify({ type: 'action-result', auditId: 88, action: 'upgrade', ok: true, version: '0.3.0' }));
      await withTimeout(done, 4000, 'audit not completed');
      assert.equal(completed[0].id, 88);
      assert.equal(completed[0].state, 'completed');
      assert.equal(completed[0].resultDetail, 'version 0.3.0');
    } finally {
      client.close();
    }
  });
});

test('a delete action-result completes the audit and removes the agent (tokens cascade)', async () => {
  const tracker = makeStatusTracker();
  let removedId = null;
  let resolveRemoved;
  const removed = new Promise((r) => { resolveRemoved = r; });
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus, remove: async (id) => { removedId = id; resolveRemoved(); return true; } });
  const completed = [];
  const auditRepo = { complete: async (id, opts) => { completed.push({ id, ...opts }); return true; } };

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo, auditRepo }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      client.send(JSON.stringify({ type: 'action-result', auditId: 5, action: 'delete', ok: true }));
      await withTimeout(removed, 4000, 'agent not removed');
      assert.equal(removedId, 9); // the connected agent's id
      assert.equal(completed[0].state, 'completed');
    } finally {
      client.close();
    }
  });
});

test('records agent.online on connect and agent.offline on disconnect', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });
  const events = [];
  let resolveOffline;
  const offlineRecorded = new Promise((r) => { resolveOffline = r; });
  const auditEventsRepo = {
    record: async (e) => { events.push(e); if (e.action === 'agent.offline') resolveOffline(e); },
  };

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo, auditEventsRepo }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    await withTimeout(waitOpen(client), 4000, 'did not open');
    await withTimeout(tracker.waitFor('online'), 4000, 'online not set');
    client.close();
    await withTimeout(offlineRecorded, 4000, 'offline not recorded');

    const online = events.find((e) => e.action === 'agent.online');
    const offline = events.find((e) => e.action === 'agent.offline');
    assert.ok(online, 'expected an agent.online audit row');
    assert.equal(online.actorType, 'agent');
    assert.equal(online.actorId, 9); // the connected agent's id (from the token)
    assert.ok(offline, 'expected an agent.offline audit row');
    assert.equal(offline.actorId, 9);
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

test('an agent.error frame is recorded in the unified audit trail (deduped per category)', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });
  let resolveRec;
  const recorded = new Promise((r) => { resolveRec = r; });
  const calls = [];
  const auditEventsRepo = { recordRecurring: async (e) => { calls.push(e); resolveRec(e); } };

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo, auditEventsRepo }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      client.send(JSON.stringify({ type: 'agent.error', category: 'config', message: 'Could not fetch monitor config', code: 'HTTP_ERROR' }));
      const e = await withTimeout(recorded, 4000, 'error not recorded');
      assert.equal(e.actorType, 'agent');
      assert.equal(e.actorId, 9); // the connected agent's id (from the token)
      assert.equal(e.action, 'agent.error');
      assert.equal(e.targetType, 'config'); // the reported category
      assert.equal(e.detail.reason, 'Could not fetch monitor config');
      assert.equal(e.detail.code, 'HTTP_ERROR');
      assert.equal(e.dedupKey, 'agent:9:error:config:HTTP_ERROR'); // repeats collapse here
    } finally {
      client.close();
    }
  });
});

test('an agent.error frame with no category/code defaults to "general" and no code', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });
  let resolveRec;
  const recorded = new Promise((r) => { resolveRec = r; });
  const auditEventsRepo = { recordRecurring: async (e) => { resolveRec(e); } };

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo, auditEventsRepo }, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      client.send(JSON.stringify({ type: 'agent.error', message: 'something broke' }));
      const e = await withTimeout(recorded, 4000, 'error not recorded');
      assert.equal(e.targetType, 'general');
      assert.equal(e.targetLabel, null);
      assert.equal(e.detail.code, null);
      assert.equal(e.dedupKey, 'agent:9:error:general');
    } finally {
      client.close();
    }
  });
});

// ---------- Connection diagnosis evidence + forced reconnect ----------

test('getConnectionInfo tracks the live session, then the disconnect (with close code)', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ port, handle }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      await withTimeout(tracker.waitFor('online'), 4000, 'online not set');

      const live = handle.getConnectionInfo(9);
      assert.equal(live.connected, true);
      assert.equal(live.sockets, 1);
      assert.ok(live.session);
      assert.ok(live.session.connectedAt);
      assert.equal(live.session.disconnectedAt, null);
      assert.ok(live.session.ip); // the peer address, for 401 attribution
      assert.equal(live.licenseAcceptsNew, true);

      client.close(1000);
      await withTimeout(tracker.waitFor('offline'), 4000, 'offline not set');
      const after = handle.getConnectionInfo(9);
      assert.equal(after.connected, false);
      assert.equal(after.sockets, 0);
      assert.ok(after.session.disconnectedAt);
      assert.equal(after.session.closeCode, 1000);
    } finally {
      client.close();
    }
  });
});

test('disconnectAgent force-closes the socket with code 4001 and returns the count', async () => {
  const tracker = makeStatusTracker();
  const agentsRepo = makeAgentsRepo({ setStatus: tracker.setStatus });

  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ port, handle }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
    try {
      await withTimeout(waitOpen(client), 4000, 'did not open');
      await withTimeout(tracker.waitFor('online'), 4000, 'online not set');

      const closedOnClient = new Promise((resolve) => client.on('close', (code) => resolve(code)));
      const closed = handle.disconnectAgent(9);
      assert.equal(closed, 1);
      const code = await withTimeout(closedOnClient, 4000, 'client saw no close');
      assert.equal(code, 4001);

      await withTimeout(tracker.waitFor('offline'), 4000, 'offline not set');
      assert.equal(handle.getConnectionInfo(9).connected, false);
    } finally {
      client.close();
    }
  });
});

test('disconnectAgent returns 0 for an agent with no live connection', async () => {
  const agentsRepo = makeAgentsRepo({ setStatus: async () => {} });
  await withWsServer({ agentTokensRepo: validRepo(), agentsRepo }, async ({ handle }) => {
    assert.equal(handle.disconnectAgent(12345), 0);
  });
});

test('a rejected token (401) is recorded as an auth failure with the source ip', async () => {
  const agentsRepo = makeAgentsRepo({ setStatus: async () => {} });
  const agentTokensRepo = makeAgentTokensRepo({ findActiveByHash: async () => null });

  await withWsServer({ agentTokensRepo, agentsRepo }, async ({ port, handle }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer stale' } });
    const rejected = new Promise((resolve) => {
      client.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      client.on('error', () => resolve(null));
    });
    const status = await withTimeout(rejected, 4000, 'handshake not rejected');
    assert.equal(status, 401);
    const live = handle.getConnectionInfo(9);
    assert.equal(live.authFailures.length, 1);
    assert.ok(live.authFailures[0].at);
    assert.ok(live.authFailures[0].ip);
  });
});

test('a license rejection (403) is recorded against the agent id', async () => {
  const agentsRepo = makeAgentsRepo({ setStatus: async () => {} });

  await withWsServer(
    { agentTokensRepo: validRepo(), agentsRepo, licenseGuard: () => false },
    async ({ port, handle }) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
      const rejected = new Promise((resolve) => {
        client.on('unexpected-response', (_req, res) => resolve(res.statusCode));
        client.on('error', () => resolve(null));
      });
      const status = await withTimeout(rejected, 4000, 'handshake not rejected');
      assert.equal(status, 403);
      const live = handle.getConnectionInfo(9); // the token maps to agent 9
      assert.ok(live.licenseRejectedAt);
      assert.equal(live.licenseAcceptsNew, false);
    }
  );
});
