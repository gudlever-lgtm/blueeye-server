'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEnrollmentCodesRepository } = require('../src/repositories/enrollmentCodesRepository');
const { createEnrollmentStore } = require('../src/services/enrollmentStore');

// ---- enrollmentCodesRepository.findAll: attach enrolled agents --------------

// A fake pool that answers the two findAll queries (codes, then agents) from
// canned rows and records the SQL it was asked to run.
function makeListPool({ codes = [], agents = [] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM enrollment_codes e/.test(sql)) return [codes];
      if (/FROM agents/.test(sql)) return [agents];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('findAll groups each code\'s enrolled agents with live online state', async () => {
  const pool = makeListPool({
    codes: [{ id: 10, status: 'used' }, { id: 11, status: 'active' }],
    agents: [
      { id: 1, enrollment_code_id: 10, display_name: 'Thomas\'s Pie', hostname: 'tepi5', status: 'online' },
      { id: 2, enrollment_code_id: 10, display_name: null, hostname: 'host-2', status: 'offline' },
    ],
  });
  const rows = await createEnrollmentCodesRepository({ pool }).findAll();
  // Code 10 enrolled two agents; name falls back to hostname, online from status.
  assert.deepEqual(rows[0].agents, [
    { id: 1, name: 'Thomas\'s Pie', online: true },
    { id: 2, name: 'host-2', online: false },
  ]);
  // Code 11 enrolled nobody.
  assert.deepEqual(rows[1].agents, []);
});

test('findAll skips the agents query when there are no codes', async () => {
  const pool = makeListPool({ codes: [] });
  const rows = await createEnrollmentCodesRepository({ pool }).findAll();
  assert.deepEqual(rows, []);
  assert.equal(pool.queries.length, 1); // only the codes query ran
});

test('findAll derives status with "used" taking priority over "expired"', async () => {
  const pool = makeListPool({ codes: [{ id: 1, status: 'used' }] });
  await createEnrollmentCodesRepository({ pool }).findAll();
  const sql = pool.queries[0].sql;
  const usedIdx = sql.indexOf("'used'");
  const expiredIdx = sql.indexOf("'expired'");
  assert.ok(usedIdx > -1 && expiredIdx > -1, 'both statuses appear in the CASE');
  assert.ok(usedIdx < expiredIdx, 'a fully-used code reads "used", not "expired"');
});

// ---- enrollmentStore.claimAndEnroll: link the new agent to its code ---------

// A fake pool whose single connection answers the claim transaction queries.
function makeClaimPool({ codeRow }) {
  const queries = [];
  const conn = {
    queries,
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM enrollment_codes WHERE code = \? FOR UPDATE/.test(sql)) return [[codeRow]];
      if (/INSERT INTO agents/.test(sql)) return [{ insertId: 77 }];
      if (/INSERT INTO agent_tokens/.test(sql)) return [{ insertId: 1 }];
      if (/UPDATE enrollment_codes/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { pool: { conn, getConnection: async () => conn } };
}

test('claimAndEnroll records the enrolling code id on the new agent', async () => {
  const { pool } = makeClaimPool({ codeRow: { id: 42, location_id: 5, used_at: null, uses_remaining: 1, is_expired: 0 } });
  const store = createEnrollmentStore({ pool });
  const res = await store.claimAndEnroll({ code: 'X', hostname: 'h', platform: 'linux', arch: 'x64', tokenHash: 'abc' });

  assert.equal(res.status, 'ok');
  assert.equal(res.agentId, 77);
  const insert = pool.conn.queries.find((q) => /INSERT INTO agents/.test(q.sql));
  assert.match(insert.sql, /enrollment_code_id/);
  assert.equal(insert.params[4], 42); // linked to the code that enrolled it
});
