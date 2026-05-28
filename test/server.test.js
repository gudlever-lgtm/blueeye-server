import '../setup-env.js';
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

// ---- Locations (RBAC + CRUD) ----

const KEYS = { viewer: 'viewer-key', operator: 'operator-key', admin: 'admin-key' };
function authHeaders(role, extra = {}) {
  return role ? { Authorization: `Bearer ${KEYS[role]}`, ...extra } : { ...extra };
}
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let createdLocationId;

test('GET /locations without a key returns 401', async () => {
  const res = await fetch(`${baseUrl}/locations`);
  assert.equal(res.status, 401);
});

test('GET /locations with an unknown key returns 401', async () => {
  const res = await fetch(`${baseUrl}/locations`, {
    headers: { Authorization: 'Bearer not-a-real-key' },
  });
  assert.equal(res.status, 401);
});

test('GET /locations as viewer returns 200 with a list', async () => {
  const res = await fetch(`${baseUrl}/locations`, { headers: authHeaders('viewer') });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test('POST /locations as viewer is forbidden (403)', async () => {
  const res = await fetch(`${baseUrl}/locations`, {
    method: 'POST',
    headers: authHeaders('viewer', JSON_HEADERS),
    body: JSON.stringify({ name: 'Aarhus – Hovedkontor' }),
  });
  assert.equal(res.status, 403);
});

test('POST /locations without a name returns 400', async () => {
  const res = await fetch(`${baseUrl}/locations`, {
    method: 'POST',
    headers: authHeaders('operator', JSON_HEADERS),
    body: JSON.stringify({ description: 'missing name' }),
  });
  assert.equal(res.status, 400);
});

test('POST /locations as operator returns 201 and the created row', async () => {
  const res = await fetch(`${baseUrl}/locations`, {
    method: 'POST',
    headers: authHeaders('operator', JSON_HEADERS),
    body: JSON.stringify({ name: 'Aarhus – Hovedkontor', description: 'Hovedkontor' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.id);
  assert.equal(body.name, 'Aarhus – Hovedkontor');
  assert.equal(body.description, 'Hovedkontor');
  assert.equal(typeof body.createdAt, 'number');
  assert.equal(body.createdAt, body.updatedAt);
  createdLocationId = body.id;
});

test('PUT /locations/:id as operator returns 200 and updates fields', async () => {
  const res = await fetch(`${baseUrl}/locations/${createdLocationId}`, {
    method: 'PUT',
    headers: authHeaders('operator', JSON_HEADERS),
    body: JSON.stringify({ name: 'Aarhus – Filial', description: null }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, 'Aarhus – Filial');
  assert.equal(body.description, null);
  assert.ok(body.updatedAt >= body.createdAt);
});

test('PUT /locations/:id without a name returns 400', async () => {
  const res = await fetch(`${baseUrl}/locations/${createdLocationId}`, {
    method: 'PUT',
    headers: authHeaders('operator', JSON_HEADERS),
    body: JSON.stringify({ description: 'still no name' }),
  });
  assert.equal(res.status, 400);
});

test('PUT /locations/:id for an unknown id returns 404', async () => {
  const res = await fetch(`${baseUrl}/locations/99999999`, {
    method: 'PUT',
    headers: authHeaders('operator', JSON_HEADERS),
    body: JSON.stringify({ name: 'Nowhere' }),
  });
  assert.equal(res.status, 404);
});

test('DELETE /locations/:id as operator is forbidden (403)', async () => {
  const res = await fetch(`${baseUrl}/locations/${createdLocationId}`, {
    method: 'DELETE',
    headers: authHeaders('operator'),
  });
  assert.equal(res.status, 403);
});

test('DELETE /locations/:id for an unknown id returns 404', async () => {
  const res = await fetch(`${baseUrl}/locations/99999999`, {
    method: 'DELETE',
    headers: authHeaders('admin'),
  });
  assert.equal(res.status, 404);
});

test('DELETE /locations/:id as admin returns 204', async () => {
  const res = await fetch(`${baseUrl}/locations/${createdLocationId}`, {
    method: 'DELETE',
    headers: authHeaders('admin'),
  });
  assert.equal(res.status, 204);
});

test('locations endpoints return 500 on DB error', async () => {
  closeDb();

  const get = await fetch(`${baseUrl}/locations`, { headers: authHeaders('viewer') });
  assert.equal(get.status, 500);

  const post = await fetch(`${baseUrl}/locations`, {
    method: 'POST',
    headers: authHeaders('operator', JSON_HEADERS),
    body: JSON.stringify({ name: 'Aarhus – Hovedkontor' }),
  });
  assert.equal(post.status, 500);

  const put = await fetch(`${baseUrl}/locations/1`, {
    method: 'PUT',
    headers: authHeaders('operator', JSON_HEADERS),
    body: JSON.stringify({ name: 'Aarhus – Hovedkontor' }),
  });
  assert.equal(put.status, 500);

  const del = await fetch(`${baseUrl}/locations/1`, {
    method: 'DELETE',
    headers: authHeaders('admin'),
  });
  assert.equal(del.status, 500);

  initDb(dbPath);
});
