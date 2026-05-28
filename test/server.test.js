import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';

import { initDb, closeDb } from '../src/db/database.js';
import { upsertAgent } from '../src/db/queries.js';
import * as registry from '../src/ws/registry.js';
import { createApp } from '../src/index.js';
import { startWsServer } from '../src/ws/server.js';
import { signAgentToken } from '../src/auth.js';
import config from '../src/config.js';

const dbPath = join(tmpdir(), `blueeye-test-${randomUUID()}.db`);
initDb(dbPath);

// Configure RBAC API keys for the REST tests.
config.apiKeys.set('admin-key', 'admin');
config.apiKeys.set('operator-key', 'operator');
config.apiKeys.set('viewer-key', 'viewer');

const app = createApp();

const WS_SECRET = 'test-ws-secret';

function startTestWs(secret = WS_SECRET) {
  return new Promise((resolve) => {
    const wss = startWsServer(0, { secret });
    wss.on('listening', () => resolve({ wss, port: wss.address().port }));
  });
}

function connectWs(port, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return new WebSocket(`ws://127.0.0.1:${port}`, { headers });
}

// Resolves to a description of how the handshake ended.
function handshakeOutcome(ws) {
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ type: 'open' }));
    ws.once('unexpected-response', (_req, res) =>
      resolve({ type: 'rejected', status: res.statusCode })
    );
    ws.once('error', (err) => resolve({ type: 'error', message: err.message }));
  });
}

async function waitFor(predicate, timeout = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

function closeWs(wss) {
  return new Promise((resolve) => wss.close(resolve));
}

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  server?.close();
  closeDb();
});

function fakeSocket() {
  return { readyState: 1, OPEN: 1, sent: [], send(d) { this.sent.push(d); } };
}

test('GET /health returns 200', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.ok(typeof body.uptime === 'number');
});

test('GET /results returns 200 with empty list', async () => {
  const res = await fetch(`${baseUrl}/results?agentId=nobody`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, []);
});

test('POST /tests with offline agent returns 404', async () => {
  const res = await fetch(`${baseUrl}/tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'operator-key' },
    body: JSON.stringify({ agentId: 'OFFLINE-01', type: 'latency', target: '8.8.8.8' }),
  });
  assert.equal(res.status, 404);
});

test('POST /tests with online agent returns 201 and testId', async () => {
  const agentId = 'ONLINE-01';
  upsertAgent({ id: agentId, hostname: 'h', platform: 'linux', status: 'online' });
  const ws = fakeSocket();
  registry.register(agentId, ws);

  const res = await fetch(`${baseUrl}/tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'operator-key' },
    body: JSON.stringify({ agentId, type: 'latency', target: '8.8.8.8', options: {} }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.testId);
  assert.equal(ws.sent.length, 1);
  assert.equal(JSON.parse(ws.sent[0]).type, 'run_test');

  registry.unregister(agentId);
});

test('GET /agents returns correct online status', async () => {
  upsertAgent({ id: 'AG-ONLINE', hostname: 'a', platform: 'linux', status: 'online' });
  upsertAgent({ id: 'AG-OFFLINE', hostname: 'b', platform: 'linux', status: 'offline' });
  registry.register('AG-ONLINE', fakeSocket());

  const res = await fetch(`${baseUrl}/agents`);
  assert.equal(res.status, 200);
  const agents = await res.json();
  const online = agents.find((a) => a.id === 'AG-ONLINE');
  const offline = agents.find((a) => a.id === 'AG-OFFLINE');
  assert.equal(online.status, 'online');
  assert.equal(offline.status, 'offline');

  registry.unregister('AG-ONLINE');
});

test('GET /health returns 500 on DB error', async () => {
  closeDb();
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.status, 'error');
  initDb(dbPath);
});

// --- RBAC ---

test('POST /tests without an API key returns 401', async () => {
  const res = await fetch(`${baseUrl}/tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'X', type: 'latency' }),
  });
  assert.equal(res.status, 401);
});

test('POST /tests with viewer role returns 403', async () => {
  const res = await fetch(`${baseUrl}/tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'viewer-key' },
    body: JSON.stringify({ agentId: 'X', type: 'latency' }),
  });
  assert.equal(res.status, 403);
});

test('POST /tests with admin role reaches the handler (201)', async () => {
  const agentId = 'RBAC-ADMIN-01';
  upsertAgent({ id: agentId, hostname: 'h', platform: 'linux', status: 'online' });
  registry.register(agentId, fakeSocket());

  const res = await fetch(`${baseUrl}/tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'admin-key' },
    body: JSON.stringify({ agentId, type: 'latency', target: '8.8.8.8' }),
  });
  assert.equal(res.status, 201);

  registry.unregister(agentId);
});

// --- WS agent-token validation ---

test('WS: a valid token connects and can register', async () => {
  const { wss, port } = await startTestWs();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = signAgentToken('WS-AGENT-01', exp, WS_SECRET);
  const ws = connectWs(port, token);

  const outcome = await handshakeOutcome(ws);
  assert.equal(outcome.type, 'open');

  ws.send(
    JSON.stringify({ type: 'register', agentId: 'WS-AGENT-01', hostname: 'h', platform: 'linux' })
  );
  assert.ok(await waitFor(() => registry.has('WS-AGENT-01')), 'agent should be registered');

  ws.close();
  registry.unregister('WS-AGENT-01');
  await closeWs(wss);
});

test('WS: a malformed token is rejected with 401', async () => {
  const { wss, port } = await startTestWs();
  const ws = connectWs(port, 'not-a-real-token');
  const outcome = await handshakeOutcome(ws);
  ws.terminate();
  await closeWs(wss);

  assert.notEqual(outcome.type, 'open');
  if (outcome.type === 'rejected') assert.equal(outcome.status, 401);
});

test('WS: a token signed with the wrong secret is rejected', async () => {
  const { wss, port } = await startTestWs();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = signAgentToken('WS-AGENT-01', exp, 'a-different-secret');
  const ws = connectWs(port, token);
  const outcome = await handshakeOutcome(ws);
  ws.terminate();
  await closeWs(wss);

  assert.notEqual(outcome.type, 'open');
  if (outcome.type === 'rejected') assert.equal(outcome.status, 401);
});

test('WS: an expired token is rejected', async () => {
  const { wss, port } = await startTestWs();
  const exp = Math.floor(Date.now() / 1000) - 10;
  const token = signAgentToken('WS-AGENT-01', exp, WS_SECRET);
  const ws = connectWs(port, token);
  const outcome = await handshakeOutcome(ws);
  ws.terminate();
  await closeWs(wss);

  assert.notEqual(outcome.type, 'open');
  if (outcome.type === 'rejected') assert.equal(outcome.status, 401);
});

test('WS: a missing token is rejected', async () => {
  const { wss, port } = await startTestWs();
  const ws = connectWs(port, null);
  const outcome = await handshakeOutcome(ws);
  ws.terminate();
  await closeWs(wss);

  assert.notEqual(outcome.type, 'open');
  if (outcome.type === 'rejected') assert.equal(outcome.status, 401);
});

test('WS: registering as a different agentId than the token closes the socket', async () => {
  const { wss, port } = await startTestWs();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = signAgentToken('WS-AGENT-REAL', exp, WS_SECRET);
  const ws = connectWs(port, token);

  const closeCode = await new Promise((resolve) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'register', agentId: 'WS-AGENT-IMPOSTER' }));
    });
    ws.once('close', (code) => resolve(code));
  });

  assert.equal(closeCode, 4003);
  assert.equal(registry.has('WS-AGENT-IMPOSTER'), false);
  await closeWs(wss);
});
