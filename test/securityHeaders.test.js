'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp } = require('../test-support/fakes');

// Baseline security headers must be present on EVERY response, regardless of
// route, auth, or licence. We assert on an arbitrary endpoint.
test('security headers are present on an arbitrary response', async () => {
  const res = await request(makeApp()).get('/health');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.match(res.headers['strict-transport-security'], /max-age=\d+/);
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('security headers are present even on a 404', async () => {
  const res = await request(makeApp()).get('/no-such-route');
  assert.equal(res.status, 404);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy']);
});
