'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAuditEventsRepository, mapRow } = require('../src/repositories/auditEventsRepository');

function fakePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) { calls.push({ sql, params }); return handler ? handler(sql, params, calls.length) : [[]]; },
  };
}

test('record() inserts a discrete row (dedup_key NULL) and returns the id', async () => {
  const pool = fakePool(() => [{ insertId: 42 }]);
  const repo = createAuditEventsRepository({ pool });
  const id = await repo.record({
    actorType: 'user', actorId: 1, actorLabel: 'a@b.c', actorRole: 'admin',
    action: 'user.update', targetType: 'user', targetId: 7, method: 'PUT', path: '/users/7',
    status: 200, detail: { email: 'a@b.c' },
  });
  assert.equal(id, 42);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO audit_events/);
  assert.ok(!/dedup_key/.test(sql), 'discrete insert must not set dedup_key');
  assert.equal(params[6], '7'); // target_id stringified
  assert.equal(params[12], JSON.stringify({ email: 'a@b.c' })); // detail serialised
});

test('recordRecurring() upserts on dedup_key and self-measures the interval', async () => {
  const pool = fakePool(() => [{}]);
  const repo = createAuditEventsRepository({ pool });
  await repo.recordRecurring({
    actorType: 'agent', actorId: 9, action: 'agent.traffic-report',
    targetType: 'traffic', dedupKey: 'agent:9:traffic-report',
  });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /ON DUPLICATE KEY UPDATE/);
  assert.match(sql, /occurrences = occurrences \+ 1/);
  assert.match(sql, /TIMESTAMPDIFF\(SECOND, last_seen_at, NOW\(\)\) \* 1000/);
  assert.equal(params[params.length - 1], 'agent:9:traffic-report'); // dedup_key last
});

test('recordRecurring() requires a dedupKey', async () => {
  const repo = createAuditEventsRepository({ pool: fakePool() });
  await assert.rejects(() => repo.recordRecurring({ action: 'x' }), /requires a dedupKey/);
});

test('findAll() filters by actor type/action and joins the agent hostname', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /LEFT JOIN agents a/);
    assert.match(sql, /ae.actor_type = \?/);
    assert.match(sql, /ae.action = \?/);
    assert.match(sql, /ORDER BY ae.last_seen_at DESC/);
    return [[{
      id: 1, ts: new Date('2026-06-01T00:00:00Z'), actor_type: 'agent', actor_id: 9,
      actor_label: null, agent_hostname: 'node-9', action: 'agent.probe', occurrences: 5,
      repeat_interval_ms: 60000, first_seen_at: new Date('2026-06-01T00:00:00Z'),
      last_seen_at: new Date('2026-06-01T01:00:00Z'),
    }]];
  });
  const repo = createAuditEventsRepository({ pool });
  const rows = await repo.findAll({ actorType: 'agent', action: 'agent.probe', limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorLabel, 'node-9'); // falls back to joined hostname
  assert.equal(rows[0].occurrences, 5);
  assert.equal(rows[0].repeatIntervalMs, 60000);
  // params: actorType, action, limit, offset
  assert.deepEqual(pool.calls[0].params, ['agent', 'agent.probe', 10, 0]);
});

test('mapRow prefers the snapshot label over the joined hostname', () => {
  const m = mapRow({ id: 1, actor_type: 'user', actor_label: 'a@b.c', agent_hostname: 'node-9', action: 'x', occurrences: 1 });
  assert.equal(m.actorLabel, 'a@b.c');
});
