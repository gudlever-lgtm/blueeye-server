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
