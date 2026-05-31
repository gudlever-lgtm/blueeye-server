'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeLicenseManager, authHeader } = require('../test-support/fakes');

test('GET /license/status returns the license state (viewer+)', async () => {
  const licenseManager = makeLicenseManager({
    getStatus: () => ({ status: 'grace', licensed: true, maxAgents: 5, serverId: 'srv-1' }),
  });
  const res = await request(makeApp({ licenseManager }))
    .get('/license/status')
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'grace');
  assert.equal(res.body.maxAgents, 5);
});

test('GET /license/status without a token returns 401', async () => {
  const res = await request(makeApp()).get('/license/status');
  assert.equal(res.status, 401);
});

test('POST /license/refresh re-validates and returns fresh status (operator)', async () => {
  let called = 0;
  const licenseManager = makeLicenseManager({
    validateOnce: async () => { called += 1; return { status: 'valid', licensed: true, maxAgents: 50, serverId: 'srv-1' }; },
  });
  const res = await request(makeApp({ licenseManager }))
    .post('/license/refresh')
    .set('Authorization', authHeader('operator'));

  assert.equal(res.status, 200);
  assert.equal(called, 1); // forced an immediate re-validation
  assert.equal(res.body.maxAgents, 50);
});

test('POST /license/refresh is forbidden for a viewer (403)', async () => {
  const res = await request(makeApp())
    .post('/license/refresh')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('POST /license/refresh without a token returns 401', async () => {
  const res = await request(makeApp()).post('/license/refresh');
  assert.equal(res.status, 401);
});
