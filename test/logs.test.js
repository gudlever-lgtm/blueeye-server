'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeLogRing, authHeader } = require('../test-support/fakes');
const { createLogger, createLogRing } = require('../src/logger');

// ---- ring buffer unit behaviour ----

test('log ring keeps only the last `capacity` records', () => {
  const ring = createLogRing({ capacity: 3, clock: () => new Date('2026-01-01T00:00:00Z') });
  for (let i = 0; i < 5; i++) ring.record({ level: 'info', msg: `line ${i}` });
  const rows = ring.list();
  assert.equal(rows.length, 3);
  // newest first
  assert.equal(rows[0].msg, 'line 4');
  assert.equal(rows[2].msg, 'line 2');
});

test('log ring filters by minimum level', () => {
  const ring = createLogRing({ capacity: 10 });
  ring.record({ level: 'info', msg: 'an info' });
  ring.record({ level: 'warn', msg: 'a warn' });
  ring.record({ level: 'error', msg: 'an error' });
  const warnPlus = ring.list({ level: 'warn' });
  assert.equal(warnPlus.length, 2);
  assert.ok(warnPlus.every((r) => r.level === 'warn' || r.level === 'error'));
});

test('log ring filters by free-text query', () => {
  const ring = createLogRing({ capacity: 10 });
  ring.record({ level: 'error', msg: 'Agent not connected', meta: { agentId: 8 } });
  ring.record({ level: 'info', msg: 'Traffic measured' });
  assert.equal(ring.list({ q: 'connected' }).length, 1);
  assert.equal(ring.list({ q: 'agentId' }).length, 1); // matches meta
});

test('logger mirrors records into the ring via onRecord', () => {
  const ring = createLogRing({ capacity: 10 });
  const logger = createLogger({ stdout: () => {}, stderr: () => {}, onRecord: ring.record });
  logger.info('hello world');
  logger.error('boom', new Error('kaboom'));
  const rows = ring.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].msg, 'boom');
  assert.equal(rows[0].level, 'error');
  assert.equal(rows[0].source, 'server');
});

test('a throwing onRecord never breaks the logger', () => {
  const logger = createLogger({ stdout: () => {}, stderr: () => {}, onRecord: () => { throw new Error('sink down'); } });
  assert.doesNotThrow(() => logger.info('still fine'));
});

// ---- route: GET /api/logs ----

test('GET /api/logs requires auth (401)', async () => {
  assert.equal((await request(makeApp()).get('/api/logs')).status, 401);
});

test('GET /api/logs is admin-only (403 for viewer and operator)', async () => {
  const app = makeApp();
  assert.equal((await request(app).get('/api/logs').set('Authorization', authHeader('viewer'))).status, 403);
  assert.equal((await request(app).get('/api/logs').set('Authorization', authHeader('operator'))).status, 403);
});

test('GET /api/logs returns buffered entries for admin', async () => {
  const logRing = makeLogRing();
  logRing.record({ level: 'error', msg: 'Agent not connected', meta: { agentId: 8 } });
  logRing.record({ level: 'info', msg: 'startup complete' });
  const res = await request(makeApp({ logRing })).get('/api/logs').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 2);
  assert.equal(res.body.entries[0].msg, 'startup complete'); // newest first
  assert.equal(res.body.capacity, 100);
});

test('GET /api/logs honours the level filter', async () => {
  const logRing = makeLogRing();
  logRing.record({ level: 'info', msg: 'quiet' });
  logRing.record({ level: 'error', msg: 'loud' });
  const res = await request(makeApp({ logRing }))
    .get('/api/logs?level=warn').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 1);
  assert.equal(res.body.entries[0].msg, 'loud');
});

// ---- route: POST /api/logs/client ----

test('POST /api/logs/client requires auth (401)', async () => {
  assert.equal((await request(makeApp()).post('/api/logs/client').send({ msg: 'x' })).status, 401);
});

test('POST /api/logs/client folds a client error into the ring', async () => {
  const logRing = makeLogRing();
  const app = makeApp({ logRing });
  const post = await request(app).post('/api/logs/client')
    .set('Authorization', authHeader('operator'))
    .send({ level: 'error', msg: 'Update agent 8: Agent not connected', meta: { status: 409 } });
  assert.equal(post.status, 204);
  // Visible to an admin in the merged view, tagged source=client
  const res = await request(app).get('/api/logs').set('Authorization', authHeader('admin'));
  assert.equal(res.body.entries.length, 1);
  assert.equal(res.body.entries[0].source, 'client');
  assert.equal(res.body.entries[0].level, 'error');
  assert.match(res.body.entries[0].msg, /Agent not connected/);
});

test('POST /api/logs/client returns 400 without a message', async () => {
  const res = await request(makeApp()).post('/api/logs/client')
    .set('Authorization', authHeader('viewer')).send({ level: 'error' });
  assert.equal(res.status, 400);
});

test('POST /api/logs/client clamps an unknown level to error', async () => {
  const logRing = makeLogRing();
  const app = makeApp({ logRing });
  await request(app).post('/api/logs/client')
    .set('Authorization', authHeader('viewer')).send({ level: 'bogus', msg: 'hi' });
  const res = await request(app).get('/api/logs').set('Authorization', authHeader('admin'));
  assert.equal(res.body.entries[0].level, 'error');
});
