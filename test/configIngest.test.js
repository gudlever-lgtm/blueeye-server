'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeConfigSnapshotsRepo, makeAgentsRepo, authHeader } = require('../test-support/fakes');

const agents = () => makeAgentsRepo({ findById: async (id) => (Number(id) === 9 ? { id: 9, hostname: 'r9' } : null) });

test('POST config-snapshots stores a raw capture for an operator → 201', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  const res = await request(makeApp({ configSnapshotsRepo, agentsRepo: agents() }))
    .post('/api/devices/9/config-snapshots').set('Authorization', authHeader('operator'))
    .send({ configText: 'hostname r9\ninterface Gi0/1\n' });
  assert.equal(res.status, 201);
  assert.equal(res.body.deviceId, 9);
  assert.equal(res.body.unchanged, false);
  assert.equal(configSnapshotsRepo.rows.length, 1);
  assert.equal(configSnapshotsRepo.rows[0].config_text, 'hostname r9\ninterface Gi0/1\n'); // stored RAW (mask-on-read)
});

test('re-posting the identical config does not create a duplicate → 200 unchanged', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  const app = makeApp({ configSnapshotsRepo, agentsRepo: agents() });
  const body = { configText: 'hostname r9\n' };
  const first = await request(app).post('/api/devices/9/config-snapshots').set('Authorization', authHeader('operator')).send(body);
  const second = await request(app).post('/api/devices/9/config-snapshots').set('Authorization', authHeader('operator')).send(body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.unchanged, true);
  assert.equal(configSnapshotsRepo.rows.length, 1); // only one row
});

test('capturedVia is validated; an unknown value falls back to manual', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  const res = await request(makeApp({ configSnapshotsRepo, agentsRepo: agents() }))
    .post('/api/devices/9/config-snapshots').set('Authorization', authHeader('admin'))
    .send({ configText: 'x', capturedVia: 'wizardry' });
  assert.equal(res.status, 201);
  assert.equal(configSnapshotsRepo.rows[0].captured_via, 'manual');
});

test('agent_poll capturedVia is accepted', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  await request(makeApp({ configSnapshotsRepo, agentsRepo: agents() }))
    .post('/api/devices/9/config-snapshots').set('Authorization', authHeader('operator'))
    .send({ configText: 'x', capturedVia: 'agent_poll' });
  assert.equal(configSnapshotsRepo.rows[0].captured_via, 'agent_poll');
});

test('empty configText is rejected → 400', async () => {
  const res = await request(makeApp({ agentsRepo: agents() }))
    .post('/api/devices/9/config-snapshots').set('Authorization', authHeader('operator')).send({ configText: '   ' });
  assert.equal(res.status, 400);
});

test('an oversized config (over the 512 KiB cap, under the body limit) is rejected → 400', async () => {
  const big = 'a'.repeat(512 * 1024 + 1);
  const res = await request(makeApp({ agentsRepo: agents() }))
    .post('/api/devices/9/config-snapshots').set('Authorization', authHeader('operator')).send({ configText: big });
  assert.equal(res.status, 400);
});

test('ingest is forbidden for a viewer → 403', async () => {
  const res = await request(makeApp({ agentsRepo: agents() }))
    .post('/api/devices/9/config-snapshots').set('Authorization', authHeader('viewer')).send({ configText: 'x' });
  assert.equal(res.status, 403);
});

test('ingest is 404 for an unknown device', async () => {
  const res = await request(makeApp({ agentsRepo: makeAgentsRepo({ findById: async () => null }) }))
    .post('/api/devices/999/config-snapshots').set('Authorization', authHeader('operator')).send({ configText: 'x' });
  assert.equal(res.status, 404);
});

test('ingest is audited', async () => {
  const audits = [];
  const auditLogger = { enabled: true, record: async (_req, e) => audits.push(e) };
  await request(makeApp({ configSnapshotsRepo: makeConfigSnapshotsRepo(), agentsRepo: agents(), auditLogger }))
    .post('/api/devices/9/config-snapshots').set('Authorization', authHeader('operator')).send({ configText: 'hostname r9\n' });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'config_snapshot_ingest');
  assert.equal(audits[0].target, '9');
});

test('ingest surfaces a repo failure as 500', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo({ insert: async () => { throw new Error('db down'); } });
  const res = await request(makeApp({ configSnapshotsRepo, agentsRepo: agents() }))
    .post('/api/devices/9/config-snapshots').set('Authorization', authHeader('operator')).send({ configText: 'x' });
  assert.equal(res.status, 500);
});
