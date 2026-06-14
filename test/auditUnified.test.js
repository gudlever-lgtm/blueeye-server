'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAuditEventsRepo, makeAuditLogRepo, makeFeatureGate, authHeader } = require('../test-support/fakes');

// audit_events rows are camelCase-mapped; audit_log.list returns RAW snake_case.
const events = [
  { id: 1, ts: '2026-06-14T10:00:00.000Z', lastSeenAt: '2026-06-14T10:00:00.000Z', actorType: 'user', actorId: 1, actorLabel: 'admin@x', actorRole: 'admin', action: 'agent.run-test', targetType: 'agent', targetId: '4', method: 'POST', path: '/agents/4/run-test', status: 202, occurrences: 1 },
];
const logs = [
  { id: 2, created_at: '2026-06-14T12:00:00.000Z', category: 'auth', action: 'auth.login', outcome: 'success', actor_user_id: 1, actor_email: 'admin@x', actor_role: 'admin', target: 'session', detail: null, ip: '1.2.3.4' },
];

function appWith(extra = {}) {
  return makeApp({
    auditEventsRepo: makeAuditEventsRepo({ findAll: async () => events }),
    auditLogRepo: makeAuditLogRepo({ list: async () => logs }),
    ...extra,
  });
}

test('GET /api/audit/all merges both stores into one newest-first timeline (admin)', async () => {
  const res = await request(appWith()).get('/api/audit/all').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 2);
  assert.equal(res.body.entries[0].category, 'auth'); // 12:00 newest
  assert.equal(res.body.entries[1].category, 'agent');
  assert.deepEqual(res.body.sources, { events: 1, log: 1 });
  assert.ok(Array.isArray(res.body.categories));
});

test('GET /api/audit/all filters by category', async () => {
  const res = await request(appWith()).get('/api/audit/all?category=agent').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 1);
  assert.equal(res.body.entries[0].source, 'events');
});

test('GET /api/audit/all excludes audit_log when the feature is unlicensed', async () => {
  const res = await request(appWith({ featureGate: makeFeatureGate({ features: { audit_log: false } }) }))
    .get('/api/audit/all').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.sources.log, 0); // licence-gated store omitted
  assert.equal(res.body.entries.length, 1);
});

test('GET /api/audit/all is admin-only', async () => {
  assert.equal((await request(appWith()).get('/api/audit/all').set('Authorization', authHeader('viewer'))).status, 403);
  assert.equal((await request(appWith()).get('/api/audit/all')).status, 401);
});

test('the per-store endpoints stay backward-compatible', async () => {
  const app = appWith();
  const a = await request(app).get('/api/audit').set('Authorization', authHeader('admin'));
  assert.equal(a.status, 200);
  assert.ok(Array.isArray(a.body)); // unchanged: a plain array of audit_events
});
