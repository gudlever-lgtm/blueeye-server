'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../src/app');
const { makeLocationsRepo, makeDb, throwingAsync } = require('../test-support/fakes');

// Build an app whose locations repository uses the given method overrides.
function appWith(repoOverrides = {}) {
  return createApp({ db: makeDb(), locationsRepo: makeLocationsRepo(repoOverrides) });
}

// ---------------------------------------------------------------- GET /locations
test('GET /locations returns 200 with the list', async () => {
  const rows = [{ id: 1, name: 'Aarhus – Hovedkontor', description: null }];
  const res = await request(appWith({ findAll: async () => rows })).get('/locations');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, rows);
});

test('GET /locations returns 500 when the repository throws', async () => {
  const res = await request(appWith({ findAll: throwingAsync() })).get('/locations');

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

// --------------------------------------------------------------- POST /locations
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
    .send({ name: 'Odense', description: 'Filial' });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, created);
});

test('POST /locations returns 400 when name is missing', async () => {
  const res = await request(appWith())
    .post('/locations')
    .send({ description: 'no name here' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.name);
});

test('POST /locations returns 500 when the repository throws', async () => {
  const res = await request(appWith({ create: throwingAsync() }))
    .post('/locations')
    .send({ name: 'Valid name' });

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

// ------------------------------------------------------------ PUT /locations/:id
test('PUT /locations/:id returns 200 on a successful update', async () => {
  const updated = { id: 3, name: 'Nyt navn', description: null };
  const res = await request(appWith({ update: async () => updated }))
    .put('/locations/3')
    .send({ name: 'Nyt navn' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, updated);
});

test('PUT /locations/:id returns 404 when the location does not exist', async () => {
  const res = await request(appWith({ update: async () => null }))
    .put('/locations/999')
    .send({ name: 'Nyt navn' });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Location not found');
});

test('PUT /locations/:id returns 400 for a non-numeric id', async () => {
  const res = await request(appWith()).put('/locations/abc').send({ name: 'Nyt navn' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Invalid id');
});

test('PUT /locations/:id returns 400 when name is missing', async () => {
  const res = await request(appWith()).put('/locations/3').send({ description: 'x' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('PUT /locations/:id returns 500 when the repository throws', async () => {
  const res = await request(appWith({ update: throwingAsync() }))
    .put('/locations/3')
    .send({ name: 'Nyt navn' });

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

// --------------------------------------------------------- DELETE /locations/:id
test('DELETE /locations/:id returns 204 on success', async () => {
  const res = await request(appWith({ remove: async () => true })).delete('/locations/3');

  assert.equal(res.status, 204);
  assert.equal(res.text, '');
});

test('DELETE /locations/:id returns 404 when the location does not exist', async () => {
  const res = await request(appWith({ remove: async () => false })).delete('/locations/999');

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Location not found');
});

test('DELETE /locations/:id returns 400 for an invalid id', async () => {
  const res = await request(appWith()).delete('/locations/-5');

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Invalid id');
});

test('DELETE /locations/:id returns 500 when the repository throws', async () => {
  const res = await request(appWith({ remove: throwingAsync() })).delete('/locations/3');

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});
