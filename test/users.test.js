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
    .send({ email: 'New@Blueeye.local', password: 'Sup3rSecret!', role: 'operator' });

  assert.equal(res.status, 201);
  assert.equal(res.body.email, 'new@blueeye.local'); // normalised to lower-case
  assert.equal(res.body.role, 'operator');
  // The plaintext is never stored; a bcrypt hash is passed to the repository.
  assert.ok(receivedHash && receivedHash !== 'Sup3rSecret!');
});

test('POST /users returns 400 for invalid input', async () => {
  const res = await request(makeApp())
    .post('/users')
    .set('Authorization', admin())
    .send({ email: 'not-an-email', password: 'short', role: 'wizard' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('POST /users returns 422 when the password fails the policy', async () => {
  const usersRepo = makeUsersRepo({ findByEmail: async () => null });
  // Long but single character class → fails the complexity rule.
  const res = await request(makeApp({ usersRepo }))
    .post('/users')
    .set('Authorization', admin())
    .send({ email: 'weak@blueeye.local', password: 'alllowercaseletters', role: 'viewer' });

  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'Password policy not met');
  assert.ok(Array.isArray(res.body.details) && res.body.details.length > 0);
});

test('PUT /users/:id returns 422 when the new password fails the policy', async () => {
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 3, email: 'u@blueeye.local', role: 'viewer' }),
  });
  const res = await request(makeApp({ usersRepo }))
    .put('/users/3')
    .set('Authorization', admin())
    .send({ role: 'operator', password: 'short' });

  // 'short' is < min length AND too few classes → policy violation (422).
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'Password policy not met');
});

test('POST /users returns 409 for a duplicate email', async () => {
  const usersRepo = makeUsersRepo({
    findByEmail: async () => ({ id: 1, email: 'dupe@blueeye.local', role: 'viewer' }),
  });

  const res = await request(makeApp({ usersRepo }))
    .post('/users')
    .set('Authorization', admin())
    .send({ email: 'dupe@blueeye.local', password: 'Sup3rSecret!', role: 'viewer' });

  assert.equal(res.status, 409);
});

test('POST /users returns 500 when the repository throws', async () => {
  const usersRepo = makeUsersRepo({ findByEmail: async () => null, create: throwingAsync() });

  const res = await request(makeApp({ usersRepo }))
    .post('/users')
    .set('Authorization', admin())
    .send({ email: 'new@blueeye.local', password: 'Sup3rSecret!', role: 'viewer' });

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

test('PUT /users/:id updates the email (normalised, in the patch) and returns 200', async () => {
  let patch;
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 3, email: 'old@blueeye.local', role: 'viewer' }),
    findByEmail: async () => null, // the new address is free
    update: async (id, p) => { patch = p; return { id, email: p.email, role: p.role }; },
  });

  const res = await request(makeApp({ usersRepo }))
    .put('/users/3')
    .set('Authorization', admin())
    .send({ email: 'New@Blueeye.local', role: 'viewer' });

  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'new@blueeye.local'); // normalised to lower-case
  assert.equal(patch.email, 'new@blueeye.local');
});

test('PUT /users/:id returns 409 when the new email belongs to another user', async () => {
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 3, email: 'old@blueeye.local', role: 'viewer' }),
    findByEmail: async () => ({ id: 9, email: 'taken@blueeye.local', role: 'viewer' }),
  });

  const res = await request(makeApp({ usersRepo }))
    .put('/users/3')
    .set('Authorization', admin())
    .send({ email: 'taken@blueeye.local', role: 'viewer' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Email already in use');
});

test('PUT /users/:id allows resubmitting the same email (no self-conflict)', async () => {
  let patch;
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 3, email: 'same@blueeye.local', role: 'viewer' }),
    findByEmail: async () => { throw new Error('uniqueness check should be skipped'); },
    update: async (id, p) => { patch = p; return { id, email: 'same@blueeye.local', role: p.role }; },
  });

  const res = await request(makeApp({ usersRepo }))
    .put('/users/3')
    .set('Authorization', admin())
    .send({ email: 'same@blueeye.local', role: 'operator' });

  assert.equal(res.status, 200);
  assert.equal(patch.email, undefined); // unchanged → not part of the patch
  assert.equal(patch.role, 'operator');
});

test('PUT /users/:id returns 400 for an invalid email', async () => {
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 3, email: 'old@blueeye.local', role: 'viewer' }),
  });

  const res = await request(makeApp({ usersRepo }))
    .put('/users/3')
    .set('Authorization', admin())
    .send({ email: 'not-an-email', role: 'viewer' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
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
    .send({ email: 'x@blueeye.local', password: 'Sup3rSecret!', role: 'viewer' });

  assert.equal(res.status, 403);
});

// ---------------------------------------------- protected (super-admin) ------
test('PUT /users/:id cannot demote a protected super-admin (409)', async () => {
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 1, email: 'admin@blueeye.local', role: 'admin', protected: true }),
  });
  const res = await request(makeApp({ usersRepo }))
    .put('/users/1')
    .set('Authorization', admin())
    .send({ role: 'viewer' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /protected/i);
});

test('PUT /users/:id can still reset a protected super-admin password', async () => {
  let patch;
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 1, email: 'admin@blueeye.local', role: 'admin', protected: true }),
    update: async (id, p) => { patch = p; return { id, email: 'admin@blueeye.local', role: 'admin', protected: true }; },
  });
  const res = await request(makeApp({ usersRepo }))
    .put('/users/1')
    .set('Authorization', admin())
    .send({ role: 'admin', password: 'A-new-Passw0rd!' });
  assert.equal(res.status, 200);
  assert.ok(patch.passwordHash); // password was reset
  assert.equal(patch.role, 'admin'); // stays admin
});

test('DELETE /users/:id cannot delete a protected super-admin (409)', async () => {
  let removed = false;
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 1, email: 'admin@blueeye.local', role: 'admin', protected: true }),
    remove: async () => { removed = true; return true; },
  });
  const res = await request(makeApp({ usersRepo }))
    .delete('/users/1')
    .set('Authorization', admin());
  assert.equal(res.status, 409);
  assert.equal(removed, false); // never reached the delete
});
