'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fromAuditEvent, fromAuditLog, mergeTrail, categoryOf } = require('../categories');

test('categoryOf derives the top-level category from a dotted action', () => {
  assert.equal(categoryOf('agent.run-test'), 'agent');
  assert.equal(categoryOf('auth.login'), 'auth');
  assert.equal(categoryOf('plain'), null);
});

test('fromAuditEvent maps an audit_events row to the canonical shape', () => {
  const c = fromAuditEvent({
    id: 7, ts: '2026-06-14T10:00:00.000Z', lastSeenAt: '2026-06-14T10:05:00.000Z',
    actorType: 'user', actorId: 1, actorLabel: 'admin@x', actorRole: 'admin',
    action: 'user.update', targetType: 'user', targetId: '2', targetLabel: null,
    method: 'PUT', path: '/users/2', status: 200, ip: '1.2.3.4', detail: { a: 1 }, occurrences: 3,
  });
  assert.equal(c.source, 'events');
  assert.equal(c.id, 'events:7');
  assert.equal(c.ts, '2026-06-14T10:05:00.000Z'); // prefers lastSeenAt
  assert.equal(c.category, 'user');
  assert.equal(c.outcome, 'success');
  assert.deepEqual(c.actor, { type: 'user', id: 1, label: 'admin@x', role: 'admin' });
  assert.equal(c.occurrences, 3);
});

test('fromAuditEvent flags a 4xx/5xx status as a failure outcome', () => {
  assert.equal(fromAuditEvent({ id: 1, action: 'auth.login', status: 401 }).outcome, 'failure');
});

test('fromAuditLog maps a raw audit_log row to the canonical shape', () => {
  const c = fromAuditLog({
    id: 9, created_at: new Date('2026-06-14T11:00:00.000Z'), category: 'license', action: 'license.revalidate',
    outcome: 'success', actor_user_id: 5, actor_email: 'ops@x', actor_role: 'admin', target: 'license', detail: 'ok', ip: '5.6.7.8',
  });
  assert.equal(c.source, 'log');
  assert.equal(c.id, 'log:9');
  assert.equal(c.ts, '2026-06-14T11:00:00.000Z');
  assert.equal(c.category, 'license');
  assert.equal(c.actor.label, 'ops@x');
  assert.equal(c.target.label, 'license');
});

test('mergeTrail merges both stores newest-first with filters + paging', () => {
  // The event is an agent action; the log is a user action (fromAuditLog always
  // attributes to a user) — so the actorType filter distinguishes them.
  const events = [fromAuditEvent({ id: 1, action: 'agent.run-test', ts: '2026-06-14T10:00:00.000Z', actorType: 'agent' })];
  const logs = [fromAuditLog({ id: 2, action: 'auth.login', category: 'auth', created_at: '2026-06-14T12:00:00.000Z' })];
  const merged = mergeTrail(events, logs, {});
  assert.equal(merged.length, 2);
  assert.equal(merged[0].category, 'auth'); // 12:00 is newer than 10:00

  assert.equal(mergeTrail(events, logs, { category: 'auth' }).length, 1);
  assert.equal(mergeTrail(events, logs, { actorType: 'user' }).length, 1); // log only
  assert.equal(mergeTrail(events, logs, { actorType: 'agent' }).length, 1); // event only
  assert.equal(mergeTrail(events, logs, { limit: 1 }).length, 1);
  assert.equal(mergeTrail(events, logs, { limit: 1, offset: 1 })[0].category, 'agent');
});
