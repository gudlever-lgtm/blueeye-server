'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../src/app');
const { makeLocationsRepo, makeDb } = require('../test-support/fakes');

function buildApp() {
  return createApp({ db: makeDb(), locationsRepo: makeLocationsRepo() });
}

test('unknown route returns 404 Not Found', async () => {
  const res = await request(buildApp()).get('/does-not-exist');

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not Found');
  assert.equal(res.body.path, '/does-not-exist');
});

test('unmatched nested path under /locations returns 404', async () => {
  const res = await request(buildApp()).post('/locations/1/children');

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not Found');
});

test('GET on a single location (no such route) returns 404', async () => {
  const res = await request(buildApp()).get('/locations/1');

  assert.equal(res.status, 404);
});
