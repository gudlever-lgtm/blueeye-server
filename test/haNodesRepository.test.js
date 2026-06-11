'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHaNodesRepository } = require('../src/repositories/haNodesRepository');

function fakePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) { calls.push({ sql, params }); return handler ? handler(sql, params) : [[]]; },
  };
}

test('heartbeat upserts this node and, when leader, clears stale leader flags on others', async () => {
  const pool = fakePool(() => [{}]);
  const repo = createHaNodesRepository({ pool });
  await repo.heartbeat({ nodeId: 'n1', hostname: 'h1', pid: 7, version: '1.0.0', isLeader: true });

  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /INSERT INTO ha_nodes/);
  assert.match(pool.calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  // Second statement clears the leader flag on every OTHER node.
  assert.match(pool.calls[1].sql, /UPDATE ha_nodes SET is_leader = 0 WHERE node_id <> \?/);
  assert.deepEqual(pool.calls[1].params, ['n1']);
});

test('heartbeat as a follower does NOT touch other nodes', async () => {
  const pool = fakePool(() => [{}]);
  const repo = createHaNodesRepository({ pool });
  await repo.heartbeat({ nodeId: 'n2', isLeader: false });
  assert.equal(pool.calls.length, 1); // only the upsert, no clear-others UPDATE
  assert.match(pool.calls[0].sql, /INSERT INTO ha_nodes/);
});

test('listActive maps is_leader/active to booleans', async () => {
  const pool = fakePool(() => [[
    { node_id: 'n1', hostname: 'h1', pid: 7, version: '1.0.0', is_leader: 1, last_seen_at: 'x', active: 1 },
    { node_id: 'n2', hostname: 'h2', pid: 8, version: '1.0.0', is_leader: 0, last_seen_at: 'y', active: 1 },
  ]]);
  const repo = createHaNodesRepository({ pool });
  const rows = await repo.listActive(60);
  assert.equal(rows[0].is_leader, true);
  assert.equal(rows[1].is_leader, false);
  assert.equal(rows[0].active, true);
});
