'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAgentsRepository } = require('../src/repositories/agentsRepository');

// Minimal fake pool: records the SQL + params and returns a canned result.
function fakePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params, calls.length);
    },
  };
}

test("markStaleOffline flips only stale 'online' rows and returns the affected count", async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /UPDATE agents SET status = 'offline'/);
    assert.match(sql, /status = 'online'/); // never touches already-offline rows
    assert.match(sql, /last_seen IS NULL OR last_seen < \(NOW\(\) - INTERVAL \? SECOND\)/);
    assert.deepEqual(params, [300]);
    return [{ affectedRows: 2 }];
  });
  const repo = createAgentsRepository({ pool });
  assert.equal(await repo.markStaleOffline({ olderThanSec: 300 }), 2);
});

test('markStaleOffline defaults the silence threshold to 300s and copes with no affectedRows', async () => {
  const pool = fakePool((sql, params) => {
    assert.deepEqual(params, [300]);
    return [{}]; // some drivers omit affectedRows
  });
  const repo = createAgentsRepository({ pool });
  assert.equal(await repo.markStaleOffline(), 0);
});

test('sweepStaleOffline selects stale online agents (minus live sockets) and flips each with the guard repeated', async () => {
  const pool = fakePool((sql, params, n) => {
    if (n === 1) {
      assert.match(sql, /SELECT id FROM agents/);
      assert.match(sql, /status = 'online'/);
      assert.match(sql, /last_seen IS NULL OR last_seen < \(NOW\(\) - INTERVAL \? SECOND\)/);
      assert.match(sql, /AND id NOT IN \(\?, \?\)/);
      assert.deepEqual(params, [240, 3, 8]);
      return [[{ id: 4 }, { id: 9 }]];
    }
    // The UPDATE re-checks status + staleness, so an agent that reconnected
    // between the two statements is not flipped.
    assert.match(sql, /UPDATE agents SET status = 'offline'/);
    assert.match(sql, /WHERE id = \? AND status = 'online'/);
    assert.match(sql, /last_seen < \(NOW\(\) - INTERVAL \? SECOND\)/);
    return [{ affectedRows: params[0] === 4 ? 1 : 0 }];
  });
  const repo = createAgentsRepository({ pool });
  assert.deepEqual(await repo.sweepStaleOffline({ olderThanSec: 240, exceptIds: [3, '8', 'x', null] }), [4]);
  assert.equal(pool.calls.length, 3);
});

test('sweepStaleOffline with nothing stale issues no UPDATE; no exceptIds means no NOT IN', async () => {
  const pool = fakePool((sql, params) => {
    assert.doesNotMatch(sql, /NOT IN/);
    assert.deepEqual(params, [300]);
    return [[]];
  });
  const repo = createAgentsRepository({ pool });
  assert.deepEqual(await repo.sweepStaleOffline(), []);
  assert.equal(pool.calls.length, 1);
});

test('peerProbesTowards reads other agents\' reachability probes to the targets, diagnostic types excluded', async () => {
  const from = new Date('2026-09-23T10:00:00Z');
  const pool = fakePool((sql, params) => {
    assert.match(sql, /FROM probe_results pr/);
    assert.match(sql, /pr\.target IN \(\?, \?\)/);
    assert.match(sql, /pr\.type NOT IN \(\?, \?, \?\)/);
    assert.match(sql, /pr\.ts >= \?/);
    assert.match(sql, /pr\.agent_id <> \?/);
    assert.match(sql, /ORDER BY pr\.ts DESC/);
    assert.deepEqual(params, ['10.0.0.1', 'h1', 'path_mtu', 'tls', 'rdns', from, 7, 50]);
    return [[{ agent_id: 2, ts: new Date('2026-09-23T10:01:00Z'), type: 'ping', target: '10.0.0.1', ok: 1, agent_name: 'h2' }]];
  });
  const repo = createAgentsRepository({ pool });
  const rows = await repo.peerProbesTowards({ targets: ['10.0.0.1', ' h1 ', '10.0.0.1', '', 5], from, excludeAgentId: 7, limit: 50 });
  assert.deepEqual(rows, [{ agentId: 2, agentName: 'h2', ts: '2026-09-23T10:01:00.000Z', type: 'ping', target: '10.0.0.1', ok: true }]);
});

test('peerProbesTowards without targets or a lower bound does not query at all', async () => {
  const pool = fakePool(() => { throw new Error('must not query'); });
  const repo = createAgentsRepository({ pool });
  assert.deepEqual(await repo.peerProbesTowards({ targets: [], from: new Date() }), []);
  assert.deepEqual(await repo.peerProbesTowards({ targets: ['10.0.0.1'] }), []);
});
