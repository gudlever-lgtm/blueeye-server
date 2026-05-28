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

// --- Locations (RBAC CRUD) ---------------------------------------------------

function locReq(path, { role, method = 'GET', body } = {}) {
  const headers = {};
  if (role) headers['X-Role'] = role;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let createdLocationId;

test('GET /locations without a role returns 401', async () => {
  const res = await locReq('/locations');
  assert.equal(res.status, 401);
});

test('GET /locations with an unknown role returns 401', async () => {
  const res = await locReq('/locations', { role: 'wizard' });
  assert.equal(res.status, 401);
});

test('GET /locations as viewer returns 200 and an array', async () => {
  const res = await locReq('/locations', { role: 'viewer' });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test('POST /locations as viewer returns 403', async () => {
  const res = await locReq('/locations', {
    role: 'viewer',
    method: 'POST',
    body: { name: 'Aarhus – Hovedkontor' },
  });
  assert.equal(res.status, 403);
});

test('POST /locations as operator returns 201 with the created location', async () => {
  const res = await locReq('/locations', {
    role: 'operator',
    method: 'POST',
    body: { name: 'Aarhus – Hovedkontor', description: 'HQ' },
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(Number.isInteger(body.id));
  assert.equal(body.name, 'Aarhus – Hovedkontor');
  assert.equal(body.description, 'HQ');
  assert.ok(typeof body.createdAt === 'number');
  assert.ok(typeof body.updatedAt === 'number');
  createdLocationId = body.id;
});

test('POST /locations without a name returns 400', async () => {
  const res = await locReq('/locations', {
    role: 'admin',
    method: 'POST',
    body: { description: 'no name' },
  });
  assert.equal(res.status, 400);
});

test('POST /locations without a description stores null', async () => {
  const res = await locReq('/locations', {
    role: 'admin',
    method: 'POST',
    body: { name: 'København – Filial' },
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.description, null);
});

test('GET /locations/:id as viewer returns the location', async () => {
  const res = await locReq(`/locations/${createdLocationId}`, { role: 'viewer' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, createdLocationId);
  assert.equal(body.name, 'Aarhus – Hovedkontor');
});

test('GET /locations/:id for an unknown id returns 404', async () => {
  const res = await locReq('/locations/999999', { role: 'viewer' });
  assert.equal(res.status, 404);
});

test('GET /locations/:id for a non-numeric id returns 404', async () => {
  const res = await locReq('/locations/not-a-number', { role: 'viewer' });
  assert.equal(res.status, 404);
});

test('PUT /locations/:id as viewer returns 403', async () => {
  const res = await locReq(`/locations/${createdLocationId}`, {
    role: 'viewer',
    method: 'PUT',
    body: { name: 'x' },
  });
  assert.equal(res.status, 403);
});

test('PUT /locations/:id as operator updates the location', async () => {
  const res = await locReq(`/locations/${createdLocationId}`, {
    role: 'operator',
    method: 'PUT',
    body: { name: 'Aarhus – Nyt Navn', description: 'updated' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, 'Aarhus – Nyt Navn');
  assert.equal(body.description, 'updated');
  assert.ok(body.updatedAt >= body.createdAt);
});

test('PUT /locations/:id for an unknown id returns 404', async () => {
  const res = await locReq('/locations/999999', {
    role: 'operator',
    method: 'PUT',
    body: { name: 'ghost' },
  });
  assert.equal(res.status, 404);
});

test('DELETE /locations/:id as operator returns 403', async () => {
  const res = await locReq(`/locations/${createdLocationId}`, {
    role: 'operator',
    method: 'DELETE',
  });
  assert.equal(res.status, 403);
});

test('DELETE /locations/:id for an unknown id as admin returns 404', async () => {
  const res = await locReq('/locations/999999', { role: 'admin', method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('DELETE /locations/:id as admin returns 204 and removes it', async () => {
  const del = await locReq(`/locations/${createdLocationId}`, {
    role: 'admin',
    method: 'DELETE',
  });
  assert.equal(del.status, 204);
  const get = await locReq(`/locations/${createdLocationId}`, { role: 'viewer' });
  assert.equal(get.status, 404);
});

test('GET /locations returns 500 on DB error', async () => {
  closeDb();
  const res = await locReq('/locations', { role: 'admin' });
  assert.equal(res.status, 500);
  initDb(dbPath);
});
