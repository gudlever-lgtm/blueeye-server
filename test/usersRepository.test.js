'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createUsersRepository } = require('../src/repositories/usersRepository');

// A minimal fake pool that backs only the preferences queries. `existing` is the
// value mysql2 would return for the JSON column (object / string / null), or
// undefined to simulate "no such user row".
function makeFakePool({ existing } = {}) {
  const queries = [];
  let stored = existing;
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^SELECT preferences FROM users/i.test(sql)) {
        return stored === undefined ? [[]] : [[{ preferences: stored }]];
      }
      if (/^UPDATE users SET preferences/i.test(sql)) {
        stored = params[0];
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('getPreferences returns the parsed object when mysql2 hands back an object', async () => {
  const repo = createUsersRepository({ pool: makeFakePool({ existing: { theme: 'nord' } }) });
  assert.deepEqual(await repo.getPreferences(1), { theme: 'nord' });
});

test('getPreferences parses a JSON string', async () => {
  const repo = createUsersRepository({ pool: makeFakePool({ existing: '{"theme":"dark"}' }) });
  assert.deepEqual(await repo.getPreferences(1), { theme: 'dark' });
});

test('getPreferences returns {} for a missing row, null value, or bad JSON', async () => {
  assert.deepEqual(await createUsersRepository({ pool: makeFakePool({}) }).getPreferences(9), {});
  assert.deepEqual(await createUsersRepository({ pool: makeFakePool({ existing: null }) }).getPreferences(1), {});
  assert.deepEqual(await createUsersRepository({ pool: makeFakePool({ existing: '{bad json' }) }).getPreferences(1), {});
});

test('updatePreferences merges with existing prefs and persists JSON', async () => {
  const pool = makeFakePool({ existing: { theme: 'light', density: 'cozy' } });
  const repo = createUsersRepository({ pool });

  const next = await repo.updatePreferences(7, { theme: 'forest' });
  assert.deepEqual(next, { theme: 'forest', density: 'cozy' }); // merged, not clobbered

  const upd = pool.queries.find((q) => /^UPDATE users SET preferences/i.test(q.sql));
  assert.equal(upd.params[1], 7); // scoped to the right user
  assert.deepEqual(JSON.parse(upd.params[0]), { theme: 'forest', density: 'cozy' }); // stored as JSON
});

test('updatePreferences writes just the patch when nothing was stored', async () => {
  const repo = createUsersRepository({ pool: makeFakePool({ existing: null }) });
  assert.deepEqual(await repo.updatePreferences(1, { theme: 'dark' }), { theme: 'dark' });
});

// A fake pool for the user-row CRUD path (id lookups + UPDATE), recording the
// SQL/params so we can assert on the generated statement.
function makeCrudPool(row) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^SELECT .* FROM users WHERE id/i.test(sql)) return [[row]];
      if (/^UPDATE users SET/i.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('update writes email, role and password_hash in one statement', async () => {
  const pool = makeCrudPool({ id: 3, email: 'old@blueeye.local', role: 'viewer', protected: 0 });
  const repo = createUsersRepository({ pool });

  await repo.update(3, { email: 'new@blueeye.local', role: 'operator', passwordHash: 'h' });

  const upd = pool.queries.find((q) => /^UPDATE users SET/i.test(q.sql));
  assert.match(upd.sql, /email = \?/);
  assert.match(upd.sql, /role = \?/);
  assert.match(upd.sql, /password_hash = \?/);
  assert.deepEqual(upd.params, ['new@blueeye.local', 'operator', 'h', 3]); // id last
});

test('update touches no columns when the patch is empty', async () => {
  const pool = makeCrudPool({ id: 3, email: 'old@blueeye.local', role: 'viewer', protected: 0 });
  const repo = createUsersRepository({ pool });

  await repo.update(3, {});

  assert.equal(pool.queries.some((q) => /^UPDATE users SET/i.test(q.sql)), false);
});
