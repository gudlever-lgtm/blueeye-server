'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeLocationsRepo, authHeader, throwingAsync } = require('../test-support/fakes');

function appWith(repoOverrides = {}) {
  return makeApp({ locationsRepo: makeLocationsRepo(repoOverrides) });
}

const admin = () => authHeader('admin');
const operator = () => authHeader('operator');
const viewer = () => authHeader('viewer');

// --------------------------------------------------------------- GET /locations
test('GET /locations returns 200 with the list', async () => {
  const rows = [{ id: 1, name: 'Aarhus – Hovedkontor', description: null }];
  const res = await request(appWith({ findAll: async () => rows }))
    .get('/locations')
    .set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, rows);
});

test('GET /locations returns 500 when the repository throws', async () => {
  const res = await request(appWith({ findAll: throwingAsync() }))
    .get('/locations')
    .set('Authorization', admin());

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

// -------------------------------------------------------------- POST /locations
test('POST /locations creates a location and returns 201', async () => {
  const created = {
    id: 7,
    name: 'Odense',
    description: 'Filial',
    created_at: 'x',
    updated_at: 'x',
  };
  const res = await request(appWith({ create: async () => created }))
    .post('/locations')
    .set('Authorization', operator())
    .send({ name: 'Odense', description: 'Filial' });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, created);
});

test('POST /locations returns 400 when name is missing', async () => {
  const res = await request(appWith())
    .post('/locations')
    .set('Authorization', operator())
    .send({ description: 'no name here' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.name);
});

test('POST /locations returns 500 when the repository throws', async () => {
  const res = await request(appWith({ create: throwingAsync() }))
    .post('/locations')
    .set('Authorization', operator())
    .send({ name: 'Valid name' });

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

// ------------------------------------------------------------ PUT /locations/:id
test('PUT /locations/:id returns 200 on a successful update', async () => {
  const updated = { id: 3, name: 'Nyt navn', description: null };
  const res = await request(appWith({ update: async () => updated }))
    .put('/locations/3')
    .set('Authorization', operator())
    .send({ name: 'Nyt navn' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, updated);
});

test('PUT /locations/:id returns 404 when the location does not exist', async () => {
  const res = await request(appWith({ update: async () => null }))
    .put('/locations/999')
    .set('Authorization', operator())
    .send({ name: 'Nyt navn' });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Location not found');
});

test('PUT /locations/:id returns 400 for a non-numeric id', async () => {
  const res = await request(appWith())
    .put('/locations/abc')
    .set('Authorization', operator())
    .send({ name: 'Nyt navn' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Invalid id');
});

test('PUT /locations/:id returns 400 when name is missing', async () => {
  const res = await request(appWith())
    .put('/locations/3')
    .set('Authorization', operator())
    .send({ description: 'x' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('PUT /locations/:id returns 500 when the repository throws', async () => {
  const res = await request(appWith({ update: throwingAsync() }))
    .put('/locations/3')
    .set('Authorization', operator())
    .send({ name: 'Nyt navn' });

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

// --------------------------------------------------------- DELETE /locations/:id
test('DELETE /locations/:id returns 204 on success', async () => {
  const res = await request(appWith({ remove: async () => true }))
    .delete('/locations/3')
    .set('Authorization', admin());

  assert.equal(res.status, 204);
  assert.equal(res.text, '');
});

test('DELETE /locations/:id returns 404 when the location does not exist', async () => {
  const res = await request(appWith({ remove: async () => false }))
    .delete('/locations/999')
    .set('Authorization', admin());

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Location not found');
});

test('DELETE /locations/:id returns 400 for an invalid id', async () => {
  const res = await request(appWith())
    .delete('/locations/-5')
    .set('Authorization', admin());

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Invalid id');
});

test('DELETE /locations/:id returns 500 when the repository throws', async () => {
  const res = await request(appWith({ remove: throwingAsync() }))
    .delete('/locations/3')
    .set('Authorization', admin());

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

// ---------------------------------------------------------------- RBAC on locations
test('GET /locations without a token returns 401', async () => {
  const res = await request(appWith()).get('/locations');

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Authentication required');
});

test('viewer may read but not create (403)', async () => {
  const res = await request(appWith())
    .post('/locations')
    .set('Authorization', viewer())
    .send({ name: 'Skanderborg' });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Forbidden');
});

test('viewer may not update (403)', async () => {
  const res = await request(appWith())
    .put('/locations/1')
    .set('Authorization', viewer())
    .send({ name: 'Skanderborg' });

  assert.equal(res.status, 403);
});

test('operator may not delete (403)', async () => {
  const res = await request(appWith())
    .delete('/locations/1')
    .set('Authorization', operator());

  assert.equal(res.status, 403);
});

test('viewer may not delete (403)', async () => {
  const res = await request(appWith())
    .delete('/locations/1')
    .set('Authorization', viewer());

  assert.equal(res.status, 403);
});
