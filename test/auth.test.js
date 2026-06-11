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
const { hashPassword } = require('../src/auth/password');

const PASSWORD = 'correct horse battery';

async function adminWithHash() {
  return {
    id: 1,
    email: 'admin@blueeye.local',
    password_hash: await hashPassword(PASSWORD),
    role: 'admin',
  };
}

// ------------------------------------------------------------- POST /auth/login
test('POST /auth/login returns a token for valid credentials', async () => {
  const user = await adminWithHash();
  const app = makeApp({
    usersRepo: makeUsersRepo({ findByEmailWithHash: async () => user }),
  });

  const res = await request(app)
    .post('/auth/login')
    .send({ email: 'admin@blueeye.local', password: PASSWORD });

  assert.equal(res.status, 200);
  assert.ok(typeof res.body.token === 'string' && res.body.token.length > 0);
  assert.equal(res.body.tokenType, 'Bearer');
  assert.equal(res.body.user.role, 'admin');
});

test('POST /auth/login returns 401 for a wrong password', async () => {
  const user = await adminWithHash();
  const app = makeApp({
    usersRepo: makeUsersRepo({ findByEmailWithHash: async () => user }),
  });

  const res = await request(app)
    .post('/auth/login')
    .send({ email: 'admin@blueeye.local', password: 'wrong-password' });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid credentials');
});

test('POST /auth/login returns 401 for an unknown email', async () => {
  const app = makeApp({
    usersRepo: makeUsersRepo({ findByEmailWithHash: async () => null }),
  });

  const res = await request(app)
    .post('/auth/login')
    .send({ email: 'nobody@blueeye.local', password: PASSWORD });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid credentials');
});

test('POST /auth/login returns 400 when fields are missing', async () => {
  const res = await request(makeApp())
    .post('/auth/login')
    .send({ email: 'admin@blueeye.local' });

  assert.equal(res.status, 400);
});

test('POST /auth/login returns 500 when the repository throws', async () => {
  const app = makeApp({
    usersRepo: makeUsersRepo({ findByEmailWithHash: throwingAsync() }),
  });

  const res = await request(app)
    .post('/auth/login')
    .send({ email: 'admin@blueeye.local', password: PASSWORD });

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

// ------------------------------------------------- Brute-force lockout (429)
test('POST /auth/login locks out after repeated failures (429, not 401)', async () => {
  const user = await adminWithHash();
  const app = makeApp({
    usersRepo: makeUsersRepo({ findByEmailWithHash: async () => user }),
  });
  const send = (password) =>
    request(app).post('/auth/login').send({ email: 'admin@blueeye.local', password });

  // Default policy: 5 failures tolerated, the 6th attempt is locked out.
  for (let i = 0; i < 5; i += 1) {
    const res = await send('wrong-password');
    assert.equal(res.status, 401, `attempt ${i + 1} should be a plain 401`);
  }
  const locked = await send('wrong-password');
  assert.equal(locked.status, 429);
  assert.ok(locked.headers['retry-after'], 'sets a Retry-After header');

  // Even the CORRECT password is refused while locked (still 429, not 200).
  const correctButLocked = await send(PASSWORD);
  assert.equal(correctButLocked.status, 429);
});

// --------------------------------------------------- Auth/RBAC on protected routes
test('protected endpoint without a token returns 401', async () => {
  const res = await request(makeApp()).get('/users');

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Authentication required');
});

test('protected endpoint with too low a role returns 403', async () => {
  const res = await request(makeApp())
    .get('/users')
    .set('Authorization', authHeader('operator'));

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Forbidden');
});

test('a malformed token returns 401', async () => {
  const res = await request(makeApp())
    .get('/users')
    .set('Authorization', 'Bearer not-a-real-jwt');

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid or expired token');
});
