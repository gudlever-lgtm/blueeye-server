'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeUsersRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

// --------------------------------------------------------------------- GET /me
test('GET /me without a token returns 401', async () => {
  const res = await request(makeApp()).get('/me');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Authentication required');
});

test('GET /me returns the identity and saved preferences', async () => {
  const usersRepo = makeUsersRepo({ getPreferences: async () => ({ theme: 'nord' }) });
  const res = await request(makeApp({ usersRepo }))
    .get('/me')
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.equal(res.body.id, 1);
  assert.equal(res.body.email, 'viewer@blueeye.local');
  assert.equal(res.body.role, 'viewer');
  assert.deepEqual(res.body.preferences, { theme: 'nord' });
});

test('GET /me returns {} preferences when none are stored', async () => {
  const res = await request(makeApp())
    .get('/me')
    .set('Authorization', authHeader('operator'));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.preferences, {});
});

test('GET /me returns 500 when the repository throws', async () => {
  const usersRepo = makeUsersRepo({ getPreferences: throwingAsync() });
  const res = await request(makeApp({ usersRepo }))
    .get('/me')
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 500);
});

// --------------------------------------------------------- PUT /me/preferences
test('PUT /me/preferences saves a valid theme (any role) and echoes it back', async () => {
  let captured;
  const usersRepo = makeUsersRepo({
    updatePreferences: async (id, patch) => { captured = { id, patch }; return { ...patch }; },
  });

  const res = await request(makeApp({ usersRepo }))
    .put('/me/preferences')
    .set('Authorization', authHeader('viewer'))
    .send({ theme: 'midnight' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.preferences, { theme: 'midnight' });
  assert.equal(captured.id, 1); // scoped to the token's user
  assert.deepEqual(captured.patch, { theme: 'midnight' });
});

test('PUT /me/preferences rejects an unknown theme (400)', async () => {
  const res = await request(makeApp())
    .put('/me/preferences')
    .set('Authorization', authHeader('viewer'))
    .send({ theme: 'rainbow' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.theme);
});

test('PUT /me/preferences rejects a non-string theme (400)', async () => {
  const res = await request(makeApp())
    .put('/me/preferences')
    .set('Authorization', authHeader('viewer'))
    .send({ theme: 42 });

  assert.equal(res.status, 400);
});

test('PUT /me/preferences rejects an empty body — nothing to update (400)', async () => {
  const res = await request(makeApp())
    .put('/me/preferences')
    .set('Authorization', authHeader('viewer'))
    .send({});

  assert.equal(res.status, 400);
});

test('PUT /me/preferences without a token returns 401', async () => {
  const res = await request(makeApp())
    .put('/me/preferences')
    .send({ theme: 'dark' });

  assert.equal(res.status, 401);
});

test('PUT /me/preferences returns 500 when the repository throws', async () => {
  const usersRepo = makeUsersRepo({ updatePreferences: throwingAsync() });
  const res = await request(makeApp({ usersRepo }))
    .put('/me/preferences')
    .set('Authorization', authHeader('admin'))
    .send({ theme: 'forest' });

  assert.equal(res.status, 500);
});
