'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeDb } = require('../test-support/fakes');

test('GET /health returns 200 when the database responds', async () => {
  const app = makeApp({ db: makeDb({ ping: async () => {} }) });

  const res = await request(app).get('/health');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.db, 'up');
});

test('GET /health returns 503 when the database is unavailable', async () => {
  const app = makeApp({
    db: makeDb({
      ping: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3306');
      },
    }),
  });

  const res = await request(app).get('/health');

  assert.equal(res.status, 503);
  assert.equal(res.body.status, 'error');
  assert.equal(res.body.db, 'down');
});
