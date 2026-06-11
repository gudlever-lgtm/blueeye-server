'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAuditLogRepository } = require('../src/repositories/auditLogRepository');

// A minimal fake mysql pool that understands only the three query shapes the
// repository issues (last hash, insert, chain scan). Rows live in an array so a
// test can tamper with stored values and re-verify.
function fakePool() {
  const rows = [];
  let seq = 0;
  return {
    rows,
    query: async (sql, params = []) => {
      if (/ORDER BY id DESC LIMIT 1/.test(sql)) {
        const last = rows[rows.length - 1];
        return [last ? [{ entry_hash: last.entry_hash }] : []];
      }
      if (/^\s*INSERT INTO audit_log/.test(sql)) {
        const [category, action, outcome, actor_user_id, actor_email, actor_role, target, detail, ip, prev_hash, entry_hash] = params;
        const row = { id: (seq += 1), category, action, outcome, actor_user_id, actor_email, actor_role, target, detail, ip, prev_hash, entry_hash };
        rows.push(row);
        return [{ insertId: row.id }];
      }
      if (/WHERE entry_hash IS NOT NULL ORDER BY id ASC/.test(sql)) {
        return [rows.filter((r) => r.entry_hash != null)];
      }
      return [[]];
    },
  };
}

test('record() chains rows and verifyChain() accepts an intact log', async () => {
  const pool = fakePool();
  const repo = createAuditLogRepository({ pool });
  await repo.record({ category: 'auth', action: 'login_success', actorEmail: 'a@b.c' });
  await repo.record({ category: 'user', action: 'user_create', target: 'x@y.z' });
  await repo.record({ category: 'license', action: 'revalidate' });

  // Each row links to the previous row's entry_hash.
  assert.equal(pool.rows[1].prev_hash, pool.rows[0].entry_hash);
  assert.equal(pool.rows[2].prev_hash, pool.rows[1].entry_hash);

  const v = await repo.verifyChain();
  assert.deepEqual(v, { ok: true, checked: 3, brokenAt: null });
});

test('verifyChain() detects a tampered field', async () => {
  const pool = fakePool();
  const repo = createAuditLogRepository({ pool });
  await repo.record({ category: 'auth', action: 'login_success', actorEmail: 'a@b.c' });
  await repo.record({ category: 'user', action: 'user_delete', target: 'victim@y.z' });

  // Someone edits a stored row after the fact — the recomputed hash won't match.
  pool.rows[1].target = 'someone-else@y.z';
  const v = await repo.verifyChain();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
});

test('verifyChain() detects a removed row (chain link broken)', async () => {
  const pool = fakePool();
  const repo = createAuditLogRepository({ pool });
  await repo.record({ category: 'auth', action: 'a1' });
  await repo.record({ category: 'auth', action: 'a2' });
  await repo.record({ category: 'auth', action: 'a3' });

  // Delete the middle row — the third row's prev_hash now dangles.
  pool.rows.splice(1, 1);
  const v = await repo.verifyChain();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 3);
});

test('verifyChain() is fine with an empty log', async () => {
  const repo = createAuditLogRepository({ pool: fakePool() });
  assert.deepEqual(await repo.verifyChain(), { ok: true, checked: 0, brokenAt: null });
});
