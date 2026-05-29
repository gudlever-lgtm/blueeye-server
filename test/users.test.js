'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4'; // keep hashing fast under test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeUsersRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const admin = () => authHeader('admin');

// ------------------------------------------------------------------- GET /users
test('GET /users returns 200 with the list (admin)', async () => {
  const rows = [{ id: 1, email: 'admin@blueeye.local', role: 'admin' }];
  const app = makeApp({ usersRepo: makeUsersRepo({ findAll: async () => rows }) });

  const res = await request(app).get('/users').set('Authorization', admin());

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, rows);
});

test('GET /users returns 500 when the repository throws', async () => {
  const app = makeApp({ usersRepo: makeUsersRepo({ findAll: throwingAsync() }) });

  const res = await request(app).get('/users').set('Authorization', admin());

  assert.equal(res.status, 500);
});

// ------------------------------------------------------------------ POST /users
test('POST /users creates a user and stores a hashed password', async () => {
  let receivedHash;
  const usersRepo = makeUsersRepo({
    findByEmail: async () => null,
    create: async ({ email, passwordHash, role }) => {
      receivedHash = passwordHash;
      return { id: 5, email, role, created_at: 'x', updated_at: 'x' };
    },
  });

  const res = await request(makeApp({ usersRepo }))
    .post('/users')
    .set('Authorization', admin())
    .send({ email: 'New@Blueeye.local', password: 'supersecret', role: 'operator' });

  assert.equal(res.status, 201);
  assert.equal(res.body.email, 'new@blueeye.local'); // normalised to lower-case
  assert.equal(res.body.role, 'operator');
  // The plaintext is never stored; a bcrypt hash is passed to the repository.
  assert.ok(receivedHash && receivedHash !== 'supersecret');
});

test('POST /users returns 400 for invalid input', async () => {
  const res = await request(makeApp())
    .post('/users')
    .set('Authorization', admin())
    .send({ email: 'not-an-email', password: 'short', role: 'wizard' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('POST /users returns 409 for a duplicate email', async () => {
  const usersRepo = makeUsersRepo({
    findByEmail: async () => ({ id: 1, email: 'dupe@blueeye.local', role: 'viewer' }),
  });

  const res = await request(makeApp({ usersRepo }))
    .post('/users')
    .set('Authorization', admin())
    .send({ email: 'dupe@blueeye.local', password: 'supersecret', role: 'viewer' });

  assert.equal(res.status, 409);
});

test('POST /users returns 500 when the repository throws', async () => {
  const usersRepo = makeUsersRepo({ findByEmail: async () => null, create: throwingAsync() });

  const res = await request(makeApp({ usersRepo }))
    .post('/users')
    .set('Authorization', admin())
    .send({ email: 'new@blueeye.local', password: 'supersecret', role: 'viewer' });

  assert.equal(res.status, 500);
});

// --------------------------------------------------------------- PUT /users/:id
test('PUT /users/:id updates the role and returns 200', async () => {
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 3, email: 'u@blueeye.local', role: 'viewer' }),
    update: async (id, patch) => ({ id, email: 'u@blueeye.local', role: patch.role }),
  });

  const res = await request(makeApp({ usersRepo }))
    .put('/users/3')
    .set('Authorization', admin())
    .send({ role: 'operator' });

  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'operator');
});

test('PUT /users/:id returns 404 when the user does not exist', async () => {
  const usersRepo = makeUsersRepo({ findById: async () => null });

  const res = await request(makeApp({ usersRepo }))
    .put('/users/999')
    .set('Authorization', admin())
    .send({ role: 'operator' });

  assert.equal(res.status, 404);
});

test('PUT /users/:id returns 400 for an invalid id', async () => {
  const res = await request(makeApp())
    .put('/users/abc')
    .set('Authorization', admin())
    .send({ role: 'operator' });

  assert.equal(res.status, 400);
});

test('PUT /users/:id returns 409 when demoting the last admin', async () => {
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 1, email: 'admin@blueeye.local', role: 'admin' }),
    countByRole: async () => 1,
  });

  const res = await request(makeApp({ usersRepo }))
    .put('/users/1')
    .set('Authorization', admin())
    .send({ role: 'viewer' });

  assert.equal(res.status, 409);
});

// ------------------------------------------------------------ DELETE /users/:id
test('DELETE /users/:id returns 204 on success', async () => {
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 4, email: 'u@blueeye.local', role: 'viewer' }),
    remove: async () => true,
  });

  const res = await request(makeApp({ usersRepo }))
    .delete('/users/4')
    .set('Authorization', admin());

  assert.equal(res.status, 204);
});

test('DELETE /users/:id returns 404 when the user does not exist', async () => {
  const usersRepo = makeUsersRepo({ findById: async () => null });

  const res = await request(makeApp({ usersRepo }))
    .delete('/users/999')
    .set('Authorization', admin());

  assert.equal(res.status, 404);
});

test('DELETE /users/:id refuses to delete the last admin (409)', async () => {
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 1, email: 'admin@blueeye.local', role: 'admin' }),
    countByRole: async () => 1,
  });

  const res = await request(makeApp({ usersRepo }))
    .delete('/users/1')
    .set('Authorization', admin());

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Cannot delete the last admin user');
});

test('DELETE /users/:id allows deleting an admin when others remain', async () => {
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 2, email: 'admin2@blueeye.local', role: 'admin' }),
    countByRole: async () => 2,
    remove: async () => true,
  });

  const res = await request(makeApp({ usersRepo }))
    .delete('/users/2')
    .set('Authorization', admin());

  assert.equal(res.status, 204);
});

test('DELETE /users/:id returns 500 when the repository throws', async () => {
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 4, email: 'u@blueeye.local', role: 'viewer' }),
    remove: throwingAsync(),
  });

  const res = await request(makeApp({ usersRepo }))
    .delete('/users/4')
    .set('Authorization', admin());

  assert.equal(res.status, 500);
});

// ----------------------------------------------------------------- RBAC on /users
test('POST /users with a non-admin token returns 403', async () => {
  const res = await request(makeApp())
    .post('/users')
    .set('Authorization', authHeader('operator'))
    .send({ email: 'x@blueeye.local', password: 'supersecret', role: 'viewer' });

  assert.equal(res.status, 403);
});
