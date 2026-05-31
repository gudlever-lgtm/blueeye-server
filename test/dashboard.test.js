'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp } = require('../test-support/fakes');

test('GET / serves the dashboard HTML', async () => {
  const res = await request(makeApp()).get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /BlueEye/);
});

test('GET /app.js serves the dashboard script', async () => {
  const res = await request(makeApp()).get('/app.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
});

test('unknown API path still returns JSON 404 (falls through static)', async () => {
  const res = await request(makeApp()).get('/definitely-not-a-file');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not Found');
});
