'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp } = require('../test-support/fakes');

test('unknown route returns 404 Not Found', async () => {
  const res = await request(makeApp()).get('/does-not-exist');

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not Found');
  assert.equal(res.body.path, '/does-not-exist');
});

test('unmatched nested path under /locations returns 404', async () => {
  // No token needed: no route matches, so the auth middleware never runs.
  const res = await request(makeApp()).post('/locations/1/children');

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not Found');
});

test('GET on a single location (no such route) returns 404', async () => {
  const res = await request(makeApp()).get('/locations/1');

  assert.equal(res.status, 404);
});
