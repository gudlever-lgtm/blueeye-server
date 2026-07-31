'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeEventCasesRepo, makeFindingStore, makeConfigSnapshotsRepo, authHeader } = require('../test-support/fakes');

test('GET /guide returns ordered steps for an operator → 200', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const id = await eventCasesRepo.create({ host_id: '9', title: 't', status: 'open', severity: 'CRIT', primary_finding_id: 'a1', first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:00:00Z') });
  const findingStore = makeFindingStore();
  await findingStore.save({ id: 'a1', hostId: '9', metric: 'probe.reachability', severity: 'CRIT', explanation: 'x', evidence: [{}], createdAt: new Date('2026-06-01T08:00:00Z') });
  await findingStore.setEventCase('a1', id);

  const res = await request(makeApp({ eventCasesRepo, findingStore }))
    .get(`/api/events/${id}/guide`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.eventId, id);
  assert.equal(res.body.primaryMetric, 'probe.reachability');
  assert.ok(res.body.steps.length >= 3);
  assert.equal(res.body.steps[0].title, 'Confirm the event is still active');
  assert.ok(res.body.steps.some((s) => /where packets are lost/i.test(s.title))); // metric-specific
});

test('GET /guide includes a config-change step when one is correlated', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  await configSnapshotsRepo.insert({ deviceId: 9, configText: 'hostname r9\n', capturedAt: new Date('2026-06-01T07:00:00Z') });
  const changeId = await configSnapshotsRepo.insert({ deviceId: 9, configText: 'hostname r9\nip access-list deny any\n', capturedAt: new Date('2026-06-01T07:50:00Z') });
  const eventCasesRepo = makeEventCasesRepo();
  const id = await eventCasesRepo.create({ host_id: '9', title: 't', status: 'open', severity: 'CRIT', config_change_id: changeId, first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:00:00Z') });

  const res = await request(makeApp({ eventCasesRepo, configSnapshotsRepo }))
    .get(`/api/events/${id}/guide`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  const cfg = res.body.steps.find((s) => /correlated config change/i.test(s.title));
  assert.ok(cfg);
  assert.match(cfg.detail, /risk: high/); // ACL change classified high
  assert.equal(cfg.action.view, 'config-context');
});

test('GET /guide is forbidden for a viewer → 403', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const id = await eventCasesRepo.create({ host_id: '9', title: 't', status: 'open', severity: 'WARN', first_event_at: new Date(), last_event_at: new Date() });
  const res = await request(makeApp({ eventCasesRepo })).get(`/api/events/${id}/guide`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('GET /guide is 400 for a non-numeric id', async () => {
  const res = await request(makeApp()).get('/api/events/abc/guide').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 400);
});

test('GET /guide is 404 for an unknown event', async () => {
  const res = await request(makeApp()).get('/api/events/9999/guide').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 404);
});

test('GET /guide surfaces a repo failure as 500', async () => {
  const eventCasesRepo = makeEventCasesRepo({ findById: async () => { throw new Error('db down'); } });
  const res = await request(makeApp({ eventCasesRepo })).get('/api/events/1/guide').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 500);
});
