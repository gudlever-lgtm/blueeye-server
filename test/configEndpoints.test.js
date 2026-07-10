'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeIncidentCasesRepo, makeConfigSnapshotsRepo, makeAgentsRepo, authHeader,
} = require('../test-support/fakes');

// ---- GET /api/devices/:id/config-history -----------------------------------

async function deviceWithHistory() {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  await configSnapshotsRepo.insert({ deviceId: 9, configText: 'hostname r9\n', capturedVia: 'manual', capturedAt: new Date('2026-06-01T07:00:00Z') });
  await configSnapshotsRepo.insert({ deviceId: 9, configText: 'hostname r9\nip access-list deny any\nsnmp-server community s3cr3t RO\n', capturedVia: 'manual', capturedAt: new Date('2026-06-01T08:00:00Z') });
  const agentsRepo = makeAgentsRepo({ findById: async (id) => (Number(id) === 9 ? { id: 9, hostname: 'r9' } : null) });
  return { configSnapshotsRepo, agentsRepo };
}

test('config-history is forbidden for a viewer → 403', async () => {
  const { configSnapshotsRepo, agentsRepo } = await deviceWithHistory();
  const res = await request(makeApp({ configSnapshotsRepo, agentsRepo })).get('/api/devices/9/config-history').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('config-history returns masked snapshots + risk-classified diffs for operator → 200', async () => {
  const { configSnapshotsRepo, agentsRepo } = await deviceWithHistory();
  const res = await request(makeApp({ configSnapshotsRepo, agentsRepo })).get('/api/devices/9/config-history').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.snapshots.length, 2);
  assert.equal(res.body.diffs.length, 1);
  assert.equal(res.body.diffs[0].risk, 'high'); // ACL change
  // masking holds: no secret, and never a raw config_text field
  const blob = JSON.stringify(res.body);
  assert.doesNotMatch(blob, /s3cr3t/);
  assert.doesNotMatch(blob, /"configText"/);
  assert.match(blob, /configTextMasked/);
});

test('config-history is 404 for an unknown device', async () => {
  const { configSnapshotsRepo } = await deviceWithHistory();
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const res = await request(makeApp({ configSnapshotsRepo, agentsRepo })).get('/api/devices/999/config-history').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 404);
});

test('config-history is 400 for a non-numeric device id', async () => {
  const res = await request(makeApp()).get('/api/devices/abc/config-history').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 400);
});

test('config-history surfaces a repo failure as 500', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo({ listForDevice: async () => { throw new Error('db down'); } });
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9 }) });
  const res = await request(makeApp({ configSnapshotsRepo, agentsRepo })).get('/api/devices/9/config-history').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 500);
});

// ---- GET /api/incidents/:id/config-context ---------------------------------

test('config-context returns the linked change + suspected-trigger note → 200', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  const prevId = await configSnapshotsRepo.insert({ deviceId: 9, configText: 'hostname r9\n', capturedVia: 'manual', capturedAt: new Date('2026-06-01T07:00:00Z') });
  const changeId = await configSnapshotsRepo.insert({ deviceId: 9, configText: 'hostname r9\nip route 0.0.0.0 0.0.0.0 10.0.0.1\n', capturedVia: 'manual', capturedAt: new Date('2026-06-01T07:45:00Z') });
  const incidentCasesRepo = makeIncidentCasesRepo();
  const id = await incidentCasesRepo.create({ host_id: '9', title: 't', status: 'open', severity: 'CRIT', config_change_id: changeId, first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:00:00Z') });

  const res = await request(makeApp({ incidentCasesRepo, configSnapshotsRepo })).get(`/api/incidents/${id}/config-context`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.configChangeId, changeId);
  assert.equal(res.body.diff.risk, 'high'); // routing change
  assert.equal(res.body.suspectedTrigger.minutesBefore, 15); // 08:00 - 07:45
  assert.match(res.body.suspectedTrigger.note, /15 minutter forinden/);
  assert.equal(prevId < changeId, true);
  // no raw IP survives the diff masking
  assert.doesNotMatch(JSON.stringify(res.body), /10\.0\.0\.1/);
});

test('config-context returns nulls when nothing is linked → 200', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo();
  const id = await incidentCasesRepo.create({ host_id: '9', title: 't', status: 'open', severity: 'WARN', first_event_at: new Date(), last_event_at: new Date() });
  const res = await request(makeApp({ incidentCasesRepo })).get(`/api/incidents/${id}/config-context`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.configChangeId, null);
  assert.equal(res.body.change, null);
});

test('config-context is forbidden for a viewer → 403', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo();
  const id = await incidentCasesRepo.create({ host_id: '9', title: 't', status: 'open', severity: 'WARN', first_event_at: new Date(), last_event_at: new Date() });
  const res = await request(makeApp({ incidentCasesRepo })).get(`/api/incidents/${id}/config-context`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('config-context is 404 for an unknown incident', async () => {
  const res = await request(makeApp()).get('/api/incidents/9999/config-context').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 404);
});

test('config-context surfaces a repo failure as 500', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo({ findById: async () => { throw new Error('db down'); } });
  const res = await request(makeApp({ incidentCasesRepo })).get('/api/incidents/1/config-context').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 500);
});
