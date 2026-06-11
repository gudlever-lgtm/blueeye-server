'use strict';

// Data-access for `auth_lockouts` — the per-(scope, identifier) failed-login
// counter behind brute-force lockout. `scope` is 'user' (login email) or 'ip'
// (source address). The service (securityService) owns the backoff maths; this
// layer only reads and upserts the row. Identifiers are truncated to the column
// width so an oversized header can never throw.
const COLS =
  'scope, identifier, fail_count, first_failed_at, last_failed_at, locked_until';

function createAuthLockoutRepository(db) {
  const { pool } = db;

  async function get(scope, identifier) {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM auth_lockouts WHERE scope = ? AND identifier = ?`,
      [scope, String(identifier).slice(0, 255)]
    );
    return rows[0] || null;
  }

  // Upserts the streak/lock state for one principal. Dates are JS Date|null.
  async function upsert(scope, identifier, { failCount, firstFailedAt, lastFailedAt, lockedUntil }) {
    await pool.query(
      `INSERT INTO auth_lockouts (scope, identifier, fail_count, first_failed_at, last_failed_at, locked_until)
         VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         fail_count = VALUES(fail_count),
         first_failed_at = VALUES(first_failed_at),
         last_failed_at = VALUES(last_failed_at),
         locked_until = VALUES(locked_until)`,
      [scope, String(identifier).slice(0, 255), failCount, firstFailedAt, lastFailedAt, lockedUntil]
    );
  }

  // Clears any failure state on a successful login.
  async function clear(scope, identifier) {
    await pool.query('DELETE FROM auth_lockouts WHERE scope = ? AND identifier = ?', [
      scope,
      String(identifier).slice(0, 255),
    ]);
  }

  return { get, upsert, clear };
}

module.exports = { createAuthLockoutRepository };
