import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { initDb, closeDb } from '../src/db/database.js';
import { upsertAgent } from '../src/db/queries.js';
import * as registry from '../src/ws/registry.js';
import { createApp } from '../src/index.js';

const dbPath = join(tmpdir(), `blueeye-test-${randomUUID()}.db`);
initDb(dbPath);
const app = createApp();

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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
