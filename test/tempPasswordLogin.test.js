'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4'; // keep hashing fast under test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeUsersRepo, authHeader } = require('../test-support/fakes');
const { hashPassword } = require('../src/auth/password');

const TEMP = 'Temp-One-Time-99!';

// A local user still holding a one-time password, expiring `hoursFromNow` hours
// out (negative = already expired).
async function tempUser(hoursFromNow = 24) {
  return {
    id: 5,
    email: 'newuser@acme.dk',
    password_hash: await hashPassword(TEMP),
    role: 'operator',
    must_change_password: true,
    temp_password_expires_at: new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString(),
  };
}

// ------------------------------------------------- login with a temp password
test('login with a valid temp password returns a token flagged mustChangePassword', async () => {
  const user = await tempUser(24);
  const app = makeApp({ usersRepo: makeUsersRepo({ findByEmailWithHash: async () => user }) });

  const res = await request(app).post('/auth/login').send({ email: user.email, password: TEMP });

  assert.equal(res.status, 200);
  assert.equal(res.body.mustChangePassword, true);
  assert.ok(res.body.token);
});

test('login with an EXPIRED temp password returns 401 temp_password_expired (not 500)', async () => {
  const user = await tempUser(-1); // expired an hour ago
  const app = makeApp({ usersRepo: makeUsersRepo({ findByEmailWithHash: async () => user }) });

  const res = await request(app).post('/auth/login').send({ email: user.email, password: TEMP });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'temp_password_expired');
});

// ------------------------------------------ the forced-change gate (403)
test('a mustChangePassword token is blocked from ordinary routes (403)', async () => {
  const token = authHeader('operator', { id: 5, email: 'newuser@acme.dk', mustChangePassword: true });

  // A route the operator role could normally reach.
  const blocked = await request(makeApp()).get('/agents').set('Authorization', token);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'password_change_required');

  // /me is deliberately allowed so the UI can still identify the user.
  const me = await request(makeApp()).get('/me').set('Authorization', token);
  assert.equal(me.status, 200);
});

// ----------------------------------------------- POST /auth/change-password
test('change-password completes the forced change and returns a fresh unflagged token', async () => {
  let cleared = null;
  const user = await tempUser(24);
  const usersRepo = makeUsersRepo({
    findByEmailWithHash: async () => user,
    clearTempPassword: async (id, hash) => { cleared = { id, hash }; return { id, must_change_password: false }; },
  });
  const token = authHeader('operator', { id: 5, email: user.email, mustChangePassword: true });

  const res = await request(makeApp({ usersRepo }))
    .post('/auth/change-password')
    .set('Authorization', token)
    .send({ currentPassword: TEMP, newPassword: 'Brand-New-Pw-2026!' });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(cleared.id, 5);
  assert.ok(cleared.hash.startsWith('$2'));

  // The fresh token is NOT flagged, so it passes the gate on a normal route.
  const ok = await request(makeApp()).get('/me').set('Authorization', `Bearer ${res.body.token}`);
  assert.equal(ok.status, 200);
});

test('change-password rejects a wrong current password with 401', async () => {
  const user = await tempUser(24);
  const usersRepo = makeUsersRepo({ findByEmailWithHash: async () => user });
  const token = authHeader('operator', { id: 5, email: user.email, mustChangePassword: true });

  const res = await request(makeApp({ usersRepo }))
    .post('/auth/change-password')
    .set('Authorization', token)
    .send({ currentPassword: 'wrong', newPassword: 'Brand-New-Pw-2026!' });

  assert.equal(res.status, 401);
});

test('change-password enforces the password policy with 422', async () => {
  const user = await tempUser(24);
  const usersRepo = makeUsersRepo({ findByEmailWithHash: async () => user });
  const token = authHeader('operator', { id: 5, email: user.email, mustChangePassword: true });

  const res = await request(makeApp({ usersRepo }))
    .post('/auth/change-password')
    .set('Authorization', token)
    .send({ currentPassword: TEMP, newPassword: 'alllowercaseletters' });

  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'Password policy not met');
});

test('change-password refuses reusing the current password (422)', async () => {
  const user = await tempUser(24);
  const usersRepo = makeUsersRepo({ findByEmailWithHash: async () => user });
  const token = authHeader('operator', { id: 5, email: user.email, mustChangePassword: true });

  const res = await request(makeApp({ usersRepo }))
    .post('/auth/change-password')
    .set('Authorization', token)
    .send({ currentPassword: TEMP, newPassword: TEMP });

  assert.equal(res.status, 422);
});

test('change-password requires both fields (400)', async () => {
  const token = authHeader('operator', { id: 5, email: 'newuser@acme.dk', mustChangePassword: true });
  const res = await request(makeApp())
    .post('/auth/change-password')
    .set('Authorization', token)
    .send({ newPassword: 'Brand-New-Pw-2026!' });
  assert.equal(res.status, 400);
});

test('change-password without any token is 401', async () => {
  const res = await request(makeApp())
    .post('/auth/change-password')
    .send({ currentPassword: 'a', newPassword: 'Brand-New-Pw-2026!' });
  assert.equal(res.status, 401);
});
