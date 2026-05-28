import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { initDb, closeDb } from '../src/db/database.js';
import { createApp } from '../src/index.js';
import { sign } from '../src/auth/jwt.js';

const dbPath = join(tmpdir(), `blueeye-users-test-${randomUUID()}.db`);
initDb(dbPath);
const app = createApp();

let server;
let baseUrl;

const adminToken = sign({ sub: 'admin-token', email: 'root@blueeye', role: 'admin' });
const viewerToken = sign({ sub: 'viewer-token', email: 'v@blueeye', role: 'viewer' });

function req(path, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

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

test('GET /users without a token returns 401', async () => {
  const res = await req('/users');
  assert.equal(res.status, 401);
});

test('GET /users with a non-admin token returns 403', async () => {
  const res = await req('/users', { token: viewerToken });
  assert.equal(res.status, 403);
});

test('GET /users with an admin token returns 200 and an empty list', async () => {
  const res = await req('/users', { token: adminToken });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('POST /users without email/password returns 400', async () => {
  const res = await req('/users', { token: adminToken, method: 'POST', body: { email: 'x@y.z' } });
  assert.equal(res.status, 400);
});

test('POST /users with an invalid role returns 400', async () => {
  const res = await req('/users', {
    token: adminToken,
    method: 'POST',
    body: { email: 'bad@role', password: 'pw', role: 'superuser' },
  });
  assert.equal(res.status, 400);
});

let aliceId;

test('POST /users creates a user and never returns the password hash', async () => {
  const res = await req('/users', {
    token: adminToken,
    method: 'POST',
    body: { email: 'alice@blueeye', password: 's3cret', role: 'operator' },
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.id);
  assert.equal(body.email, 'alice@blueeye');
  assert.equal(body.role, 'operator');
  assert.equal(body.password_hash, undefined);
  assert.equal(body.passwordHash, undefined);
  aliceId = body.id;
});

test('POST /users with a duplicate email returns 409', async () => {
  const res = await req('/users', {
    token: adminToken,
    method: 'POST',
    body: { email: 'alice@blueeye', password: 'again' },
  });
  assert.equal(res.status, 409);
});

test('GET /users lists the created user', async () => {
  const res = await req('/users', { token: adminToken });
  assert.equal(res.status, 200);
  const users = await res.json();
  assert.ok(users.some((u) => u.id === aliceId && u.email === 'alice@blueeye'));
});

test('PUT /users/:id for an unknown id returns 404', async () => {
  const res = await req('/users/does-not-exist', {
    token: adminToken,
    method: 'PUT',
    body: { role: 'viewer' },
  });
  assert.equal(res.status, 404);
});

test('PUT /users/:id updates the role', async () => {
  const res = await req(`/users/${aliceId}`, {
    token: adminToken,
    method: 'PUT',
    body: { role: 'viewer' },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, 'viewer');
});

test('PUT /users/:id supports an optional password reset', async () => {
  const res = await req(`/users/${aliceId}`, {
    token: adminToken,
    method: 'PUT',
    body: { password: 'rotated-password' },
  });
  assert.equal(res.status, 200);
});

test('DELETE /users/:id for an unknown id returns 404', async () => {
  const res = await req('/users/does-not-exist', { token: adminToken, method: 'DELETE' });
  assert.equal(res.status, 404);
});

let rootAdminId;

test('the last admin cannot be deleted', async () => {
  const created = await req('/users', {
    token: adminToken,
    method: 'POST',
    body: { email: 'root@admins', password: 'pw', role: 'admin' },
  });
  rootAdminId = (await created.json()).id;

  const res = await req(`/users/${rootAdminId}`, { token: adminToken, method: 'DELETE' });
  assert.equal(res.status, 409);
});

test('the last admin cannot be demoted', async () => {
  const res = await req(`/users/${rootAdminId}`, {
    token: adminToken,
    method: 'PUT',
    body: { role: 'viewer' },
  });
  assert.equal(res.status, 409);
});

test('an admin can be deleted once another admin exists', async () => {
  const created = await req('/users', {
    token: adminToken,
    method: 'POST',
    body: { email: 'second@admins', password: 'pw', role: 'admin' },
  });
  assert.equal(created.status, 201);

  const res = await req(`/users/${rootAdminId}`, { token: adminToken, method: 'DELETE' });
  assert.equal(res.status, 204);
});

test('DELETE /users/:id removes a user', async () => {
  const res = await req(`/users/${aliceId}`, { token: adminToken, method: 'DELETE' });
  assert.equal(res.status, 204);

  const list = await (await req('/users', { token: adminToken })).json();
  assert.equal(list.some((u) => u.id === aliceId), false);
});

test('GET /users returns 500 on a DB error', async () => {
  closeDb();
  const res = await req('/users', { token: adminToken });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.ok(body.error);
  initDb(dbPath);
});
