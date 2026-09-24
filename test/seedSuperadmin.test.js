'use strict';

// scripts/seed-superadmin.js is the break-glass reset. It used to rewrite
// password_hash without touching password_changed_at (migration 041), so with a
// password max age on, a reset superadmin could be handed a password that was
// already "expired" by the old stamp.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { upsertSuperadmin } = require('../scripts/seed-superadmin');
const { passwordSetAt, isPasswordExpired } = require('../src/auth/securityPolicy');

function fakeConn() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return [{ affectedRows: 1 }]; } };
}

test('seed-superadmin stamps password_changed_at on insert AND on the reset of an existing row', async () => {
  const conn = fakeConn();
  await upsertSuperadmin(conn, { email: 'admin@blueeye.local', passwordHash: 'scrypt$x' });
  assert.equal(conn.calls.length, 1);
  const { sql, params } = conn.calls[0];
  assert.match(sql, /INSERT INTO users \(email, password_hash, password_changed_at, role, protected\)\s+VALUES \(\?, \?, NOW\(\), 'admin', 1\)/);
  const onDup = sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE'));
  assert.match(onDup, /password_hash = VALUES\(password_hash\)/);
  assert.match(onDup, /password_changed_at = NOW\(\)/, 'a reset restarts the max-age clock');
  assert.match(onDup, /role = 'admin', protected = 1/);
  assert.deepEqual(params, ['admin@blueeye.local', 'scrypt$x']);
});

test('why it matters: the policy dates a password by password_changed_at, not by when the row was created', () => {
  const now = Date.parse('2026-09-24T10:00:00Z');
  const old = new Date(now - 400 * 86400e3);
  // Before the fix: the hash changed, the stamp did not — expired on the spot.
  assert.equal(isPasswordExpired(passwordSetAt({ password_changed_at: old, created_at: old }), 90, now), true);
  // After: NOW() on the reset restarts the clock.
  assert.equal(isPasswordExpired(passwordSetAt({ password_changed_at: new Date(now), created_at: old }), 90, now), false);
});

test('migrate.js seeds the initial admin with password_changed_at stamped too', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'migrate.js'), 'utf8');
  assert.match(src, /INSERT INTO users \(email, password_hash, password_changed_at, role\) VALUES \(\?, \?, NOW\(\), \?\)/);
});
