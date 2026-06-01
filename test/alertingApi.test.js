'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeDispatcher, authHeader } = require('../test-support/fakes');

const viewer = () => authHeader('viewer');
const operator = () => authHeader('operator');

test('GET /api/alerting/config returns the rules (no secrets)', async () => {
  const dispatcher = makeDispatcher({
    describe: () => ({ enabled: true, cooldownMs: 1000, channels: { webhook: { enabled: true, minSeverity: 'CRIT', url: 'https://h/x', signed: true } } }),
  });
  const res = await request(makeApp({ dispatcher })).get('/api/alerting/config').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.channels.webhook.signed, true);
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes('secret'));
});

test('GET /api/alerting/config without a token returns 401', async () => {
  const res = await request(makeApp()).get('/api/alerting/config');
  assert.equal(res.status, 401);
});

test('POST /api/alerting/test with an unknown channel returns 404', async () => {
  const res = await request(makeApp()).post('/api/alerting/test').set('Authorization', operator()).send({ channel: 'nope' });
  assert.equal(res.status, 404);
});

test('POST /api/alerting/test with a known channel returns 200 + result', async () => {
  const dispatcher = makeDispatcher({ test: async (c) => ({ channel: c, ok: true, detail: 'sent' }) });
  const res = await request(makeApp({ dispatcher })).post('/api/alerting/test').set('Authorization', operator()).send({ channel: 'syslog' });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.ok, true);
});

test('POST /api/alerting/test without a channel returns 400', async () => {
  const res = await request(makeApp()).post('/api/alerting/test').set('Authorization', operator()).send({});
  assert.equal(res.status, 400);
});

test('POST /api/alerting/test as a viewer returns 403', async () => {
  const res = await request(makeApp()).post('/api/alerting/test').set('Authorization', viewer()).send({ channel: 'syslog' });
  assert.equal(res.status, 403);
});

test('a dispatcher failure surfaces as 500 via the error handler', async () => {
  const dispatcher = makeDispatcher({ test: async () => { throw new Error('boom'); } });
  const res = await request(makeApp({ dispatcher })).post('/api/alerting/test').set('Authorization', operator()).send({ channel: 'syslog' });
  assert.equal(res.status, 500);
});
