'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../src/app');
const { makeLocationsRepo, makeDb } = require('../test-support/fakes');

test('GET /health returns 200 when the database responds', async () => {
  const app = createApp({
    db: makeDb({ ping: async () => {} }),
    locationsRepo: makeLocationsRepo(),
  });

  const res = await request(app).get('/health');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.db, 'up');
});

test('GET /health returns 503 when the database is unavailable', async () => {
  const app = createApp({
    db: makeDb({
      ping: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3306');
      },
    }),
    locationsRepo: makeLocationsRepo(),
  });

  const res = await request(app).get('/health');

  assert.equal(res.status, 503);
  assert.equal(res.body.status, 'error');
  assert.equal(res.body.db, 'down');
});
