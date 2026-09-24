'use strict';

// Host details on read routes are an admin's: the database name, disk and log
// paths, the update command line and raw error texts describe the installation.
// Viewers and operators still get every number (found by scripts/verify-routes).

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { storageForRole, updateForRole } = require('../src/routes/system');

const STORAGE = {
  at: '2026-09-24T00:00:00Z',
  disk: { path: '/var/lib/mysql', totalBytes: 100, freeBytes: 40, available: true },
  database: { name: 'blueeye_prod', totalBytes: 50, tables: [{ name: 'results', bytes: 10, rows: 3 }] },
  tsdb: { configured: true, available: false, error: 'connect ECONNREFUSED tsdb.internal:5432' },
  ingest: { rows: 5 },
};

test('storage: a viewer gets the sizes but not the database name, disk path or raw errors', () => {
  const v = storageForRole(STORAGE, false);
  assert.equal(v.database.name, null);
  assert.equal(v.disk.path, null);
  assert.equal(v.tsdb.error, 'unavailable');
  assert.equal(v.database.totalBytes, 50);
  assert.equal(v.database.tables[0].name, 'results', 'table names are the product\'s own, not the host\'s');
  assert.equal(v.disk.freeBytes, 40);
  assert.doesNotMatch(JSON.stringify(v), /blueeye_prod|\/var\/lib|tsdb\.internal/);
});

test('storage: an admin sees everything unchanged', () => {
  assert.deepEqual(storageForRole(STORAGE, true), STORAGE);
});

test('update status: the log path and command line are admin-only', () => {
  const status = { configured: true, running: false, command: '/opt/blueeye/scripts/deploy.sh', logPath: '/data/update.log', lastRun: null };
  assert.deepEqual(updateForRole(status, false), { ...status, command: null, logPath: null });
  assert.deepEqual(updateForRole(status, true), status);
});

test('update status: who started the last run (an admin\'s email) is admin-only; the rest of lastRun is viewer+', () => {
  const lastRun = {
    startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:03:00.000Z', exitCode: 0,
    requestedBy: 'ops-admin@example.com', targetVersion: '0.189.0', outcome: 'success', note: null,
  };
  const status = { configured: true, running: false, command: '/opt/blueeye/scripts/deploy.sh', logPath: '/data/update.log', lastRun };
  const viewer = updateForRole(status, false);
  assert.equal(viewer.lastRun.requestedBy, null);
  assert.deepEqual(viewer.lastRun, { ...lastRun, requestedBy: null }, 'outcome, timing and target stay visible');
  assert.equal(JSON.stringify(viewer).includes('ops-admin@example.com'), false);
  assert.equal(status.lastRun.requestedBy, 'ops-admin@example.com', 'the service\'s object is not mutated');
  assert.deepEqual(updateForRole(status, true), status, 'an admin sees who ran it');
});

test('GET /system/version: a viewer never receives lastRun.requestedBy; an admin does', async () => {
  const lastRun = { startedAt: '2026-09-24T10:00:00.000Z', finishedAt: null, exitCode: null, requestedBy: 'ops-admin@example.com', targetVersion: '0.189.0', outcome: 'running', note: null };
  const serverUpdateService = {
    status: () => ({ configured: true, command: '/opt/deploy.sh', logPath: '/data/update.log', running: true, lastRun: { ...lastRun } }),
    tail: () => '', isRunning: () => true, start: () => ({ started: false, reason: 'running' }),
  };
  const request = require('supertest');
  const { makeApp, authHeader } = require('../test-support/fakes');
  const app = makeApp({ serverUpdateService });
  const viewer = await request(app).get('/system/version').set('Authorization', authHeader('viewer'));
  assert.equal(viewer.status, 200);
  assert.equal(viewer.body.update.lastRun.requestedBy, null);
  assert.equal(viewer.body.update.lastRun.outcome, 'running');
  assert.equal(JSON.stringify(viewer.body).includes('ops-admin@example.com'), false);
  const admin = await request(app).get('/system/version').set('Authorization', authHeader('admin'));
  assert.equal(admin.body.update.lastRun.requestedBy, 'ops-admin@example.com');
});

test('GeoIP update status: the build path is admin-only, the rest is viewer+', async () => {
  const request = require('supertest');
  const { makeApp, authHeader } = require('../test-support/fakes');
  const geoipUpdater = { trigger: () => ({}), status: () => ({ state: 'ok', month: '2026-09', buildPath: '/data/geoip.csv' }) };
  const app = makeApp({ geoipUpdater });
  const viewer = await request(app).get('/api/settings/geoip/update').set('Authorization', authHeader('viewer'));
  assert.deepEqual(viewer.body.update, { state: 'ok', month: '2026-09', buildPath: null });
  const admin = await request(app).get('/api/settings/geoip/update').set('Authorization', authHeader('admin'));
  assert.equal(admin.body.update.buildPath, '/data/geoip.csv');
});
