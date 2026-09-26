'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTrustKeyIdentityRepository } = require('../trustKeyIdentityRepository');
const { CLEARED_FINGERPRINT } = require('../../license/keyIdentity');

// A scripted pool: it asserts the SQL and the parameters, which is what this
// repository's behaviour actually consists of. Whether the SQL is valid is a
// different question, answered by `npm run verify-schema` against MySQL.
function makePool() {
  const calls = [];
  return {
    calls,
    _rows: [],
    async query(sql, params) {
      calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
      if (/^\s*SELECT/i.test(sql)) return [this._rows];
      return [{ affectedRows: 1 }];
    },
  };
}

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

test('record() is an upsert, so two workers booting together do not invent a change', async () => {
  const pool = makePool();
  const repo = createTrustKeyIdentityRepository({ pool });
  await repo.record({ kind: 'agent_release', fingerprint: A, firstSeenAt: '2026-01-01 00:00:00.000' });
  const [sql, params] = pool.calls[0];
  assert.match(sql, /INSERT INTO trust_key_identity/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE fingerprint = VALUES\(fingerprint\)/);
  assert.deepEqual(params, ['agent_release', A, '2026-01-01 00:00:00.000']);
  // ...and it reads the row back, so the caller sees what was stored.
  assert.match(pool.calls[1][0], /^SELECT \* FROM trust_key_identity/);
});

test('recordChange() keeps the old fingerprint, counts up, and clears any acknowledgement', async () => {
  const pool = makePool();
  const repo = createTrustKeyIdentityRepository({ pool });
  await repo.recordChange({ kind: 'agent_release', fingerprint: B, previous: A, changedAt: '2026-02-02 10:00:00.000' });
  const [sql, params] = pool.calls[0];
  assert.match(sql, /change_count = change_count \+ 1/);
  assert.match(sql, /acknowledged_fingerprint = NULL/, 'a new value is never born acknowledged');
  assert.deepEqual(params, ['agent_release', B, A, '2026-02-02 10:00:00.000', '2026-02-02 10:00:00.000']);
});

test('a DELETED key is stored as the sentinel, not as NULL — the column cannot hold one', async () => {
  const pool = makePool();
  const repo = createTrustKeyIdentityRepository({ pool });
  await repo.recordChange({ kind: 'agent_release', fingerprint: null, previous: A, changedAt: '2026-02-02 10:00:00.000' });
  assert.equal(pool.calls[0][1][1], CLEARED_FINGERPRINT);
  assert.equal(pool.calls[0][1][2], A, 'and the key that was lost is still named');
});

test('acknowledge() stores the fingerprint signed off on, not a flag', async () => {
  const pool = makePool();
  const repo = createTrustKeyIdentityRepository({ pool });
  await repo.acknowledge({ kind: 'license', fingerprint: B, at: '2026-03-03 09:00:00.000', userId: 4 });
  const [sql, params] = pool.calls[0];
  assert.match(sql, /SET acknowledged_fingerprint = \?/);
  assert.deepEqual(params, [B, '2026-03-03 09:00:00.000', 4, 'license']);
});

test('get() returns null rather than undefined when the kind has never been seen', async () => {
  const pool = makePool();
  const repo = createTrustKeyIdentityRepository({ pool });
  assert.equal(await repo.get('license'), null);
});
