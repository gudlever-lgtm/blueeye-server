'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildTimeline, statusFromDetail } = require('../src/incidentCases/timeline');
const { createAuditEventsRepository } = require('../src/repositories/auditEventsRepository');
const { createAuditLogRepository } = require('../src/repositories/auditLogRepository');
const {
  makeApp, makeIncidentCasesRepo, makeFindingStore, makeAuditEventsRepo, makeAuditLogRepo, authHeader,
} = require('../test-support/fakes');

// ---- pure builder ----------------------------------------------------------

test('buildTimeline merges the sources into one chronological flat list', () => {
  const events = buildTimeline({
    anomalies: [
      { id: 'a2', createdAt: '2026-06-01T08:10:00Z', metric: 'cpu', severity: 'CRIT', explanation: 'cpu spike', window: ['2026-06-01T08:10:00Z', '2026-06-01T08:12:00Z'] },
      { id: 'a1', createdAt: '2026-06-01T08:00:00Z', metric: 'mem', severity: 'WARN', explanation: 'mem high', window: [] },
    ],
    configChanges: [
      { id: 5, lastSeenAt: '2026-06-01T08:05:00Z', action: 'agent.update', actorLabel: 'op@x' },
    ],
    statusChanges: [
      { id: 9, created_at: '2026-06-01T08:15:00Z', action: 'incident_status_change', detail: 'open→investigating', actor_email: 'op@x' },
    ],
  });
  assert.deepEqual(events.map((e) => e.type), ['anomaly', 'config_change', 'anomaly', 'status_change']);
  assert.deepEqual(events.map((e) => e.timestamp), [
    '2026-06-01T08:00:00.000Z', '2026-06-01T08:05:00.000Z', '2026-06-01T08:10:00.000Z', '2026-06-01T08:15:00.000Z',
  ]);
  assert.equal(events[0].severity, 'WARN');
  assert.equal(events[2].endedAt, '2026-06-01T08:12:00.000Z');
  assert.equal(events[3].status, 'investigating');
  assert.deepEqual(events[3].ref, { kind: 'audit_log', id: 9 });
});

test('buildTimeline returns [] with no sources', () => {
  assert.deepEqual(buildTimeline(), []);
  assert.deepEqual(buildTimeline({ anomalies: [], configChanges: [], statusChanges: [] }), []);
});

test('buildTimeline tolerates both snake_case and camelCase status rows', () => {
  const [e] = buildTimeline({ statusChanges: [{ id: 1, createdAt: '2026-06-01T08:00:00Z', detail: 'closed→open: recurred', actorRole: 'system' }] });
  assert.equal(e.timestamp, '2026-06-01T08:00:00.000Z');
  assert.equal(e.status, 'open');
  assert.equal(e.actor, 'system');
});

test('statusFromDetail extracts the target status', () => {
  assert.equal(statusFromDetail('open→investigating'), 'investigating');
  assert.equal(statusFromDetail('investigating→resolved (no new anomalies for 15m)'), 'resolved');
  assert.equal(statusFromDetail('nonsense'), null);
  assert.equal(statusFromDetail(null), null);
});

// ---- repo read methods -----------------------------------------------------

function fakePool(handler) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return handler(sql, params, calls.length); } };
}

test('auditEvents.findByTarget filters target_type/target_id + window, oldest-first', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /ae\.target_type = \?/);
    assert.match(sql, /ae\.target_id = \?/);
    assert.match(sql, /ORDER BY ae\.last_seen_at ASC/);
    assert.equal(params[0], 'agent');
    assert.equal(params[1], '9');
    return [[]];
  });
  const repo = createAuditEventsRepository({ pool });
  assert.deepEqual(await repo.findByTarget({ targetType: 'agent', targetId: 9 }), []);
});

test('auditLog.listByTarget filters by target + category, oldest-first', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /WHERE target = \? AND category = \?/);
    assert.match(sql, /ORDER BY id ASC/);
    assert.deepEqual(params.slice(0, 2), ['42', 'incident']);
    return [[]];
  });
  const repo = createAuditLogRepository({ pool });
  assert.deepEqual(await repo.listByTarget({ category: 'incident', target: 42 }), []);
});

// ---- GET /api/incidents/:id/timeline ---------------------------------------

async function seedIncident({ status = 'open' } = {}) {
  const incidentCasesRepo = makeIncidentCasesRepo();
  const id = await incidentCasesRepo.create({
    host_id: '9', title: 't', status, severity: 'CRIT', primary_finding_id: 'a1',
    first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:10:00Z'),
  });
  return { incidentCasesRepo, id };
}

test('GET timeline for an empty incident returns 200 with no events', async () => {
  const { incidentCasesRepo, id } = await seedIncident();
  const app = makeApp({ incidentCasesRepo, findingStore: makeFindingStore() });
  const res = await request(app).get(`/api/incidents/${id}/timeline`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.incidentId, id);
  assert.deepEqual(res.body.events, []);
});

test('GET timeline aggregates anomalies + config-changes + status changes → 200', async () => {
  const { incidentCasesRepo, id } = await seedIncident();

  const findingStore = makeFindingStore();
  await findingStore.save({ id: 'a1', hostId: '9', metric: 'cpu', severity: 'CRIT', explanation: 'cpu spike', evidence: [{}], createdAt: new Date('2026-06-01T08:01:00Z') });
  await findingStore.setIncidentCase('a1', id);

  const auditEventsRepo = makeAuditEventsRepo();
  await auditEventsRepo.record({ actorType: 'user', actorLabel: 'op@x', action: 'agent.update', targetType: 'agent', targetId: '9', method: 'PUT', path: '/agents/9' });

  const auditLogRepo = makeAuditLogRepo();
  await auditLogRepo.record({ category: 'incident', action: 'incident_status_change', target: String(id), detail: 'open→investigating', actorEmail: 'op@x' });

  const app = makeApp({ incidentCasesRepo, findingStore, auditEventsRepo, auditLogRepo });
  const res = await request(app).get(`/api/incidents/${id}/timeline`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const types = res.body.events.map((e) => e.type).sort();
  assert.deepEqual(types, ['anomaly', 'config_change', 'status_change']);
  const anomaly = res.body.events.find((e) => e.type === 'anomaly');
  assert.equal(anomaly.severity, 'CRIT');
  assert.deepEqual(anomaly.ref, { kind: 'anomaly', id: 'a1' });
  const cfg = res.body.events.find((e) => e.type === 'config_change');
  assert.match(cfg.description, /agent\.update/);
  const st = res.body.events.find((e) => e.type === 'status_change');
  assert.equal(st.status, 'investigating');
});

test('GET timeline only correlates config-changes on the SAME device', async () => {
  const { incidentCasesRepo, id } = await seedIncident(); // host_id '9'
  const auditEventsRepo = makeAuditEventsRepo();
  await auditEventsRepo.record({ actorType: 'user', action: 'agent.update', targetType: 'agent', targetId: '7' }); // other device
  const app = makeApp({ incidentCasesRepo, findingStore: makeFindingStore(), auditEventsRepo });
  const res = await request(app).get(`/api/incidents/${id}/timeline`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.events, []); // the config change on agent 7 is not included
});

test('GET timeline is 404 for an unknown incident', async () => {
  const app = makeApp();
  const res = await request(app).get('/api/incidents/9999/timeline').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET timeline is 400 for a non-numeric id', async () => {
  const app = makeApp();
  const res = await request(app).get('/api/incidents/abc/timeline').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET timeline surfaces a repo failure as 500', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo({ findById: async () => { throw new Error('db down'); } });
  const app = makeApp({ incidentCasesRepo });
  const res = await request(app).get('/api/incidents/1/timeline').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

test('GET timeline requires auth → 401', async () => {
  const app = makeApp();
  assert.equal((await request(app).get('/api/incidents/1/timeline')).status, 401);
});
