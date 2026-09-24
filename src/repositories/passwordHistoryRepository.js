'use strict';

// Data access for `password_history` (migration 041): the bcrypt hashes of a
// local user's past passwords, newest-first by id, so a password change can
// refuse to reuse one of the last N. Hashes only — never plaintext. Rows go
// with the user (FK ON DELETE CASCADE).
//
// The depth N is policy (app_settings `security.passwordHistory`), not schema,
// so callers pass it in; this layer only reads, appends and prunes.

function toLimit(n) {
  const v = Number(n);
  return Number.isInteger(v) && v > 0 ? Math.min(v, 100) : 0;
}

function createPasswordHistoryRepository(db) {
  const { pool } = db;

  // The `limit` most recent hashes for a user, newest first.
  async function recentHashes(userId, limit) {
    const n = toLimit(limit);
    if (!n) return [];
    const [rows] = await pool.query(
      'SELECT password_hash FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [userId, n]
    );
    return rows.map((r) => r.password_hash);
  }

  async function record(userId, passwordHash) {
    await pool.query(
      'INSERT INTO password_history (user_id, password_hash) VALUES (?, ?)',
      [userId, passwordHash]
    );
  }

  // Keeps only the `keep` newest rows for a user (0 = delete them all).
  // Two statements rather than a DELETE … WHERE id NOT IN (SELECT … LIMIT),
  // which MySQL refuses: find the oldest id worth keeping, drop everything
  // older. Returns how many rows went.
  async function prune(userId, keep) {
    const n = toLimit(keep);
    if (!n) {
      const [res] = await pool.query('DELETE FROM password_history WHERE user_id = ?', [userId]);
      return res.affectedRows || 0;
    }
    const [rows] = await pool.query(
      'SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
      [userId, n - 1]
    );
    if (!rows[0]) return 0; // fewer than `keep` rows — nothing to prune
    const [res] = await pool.query(
      'DELETE FROM password_history WHERE user_id = ? AND id < ?',
      [userId, rows[0].id]
    );
    return res.affectedRows || 0;
  }

  return { recentHashes, record, prune };
}

module.exports = { createPasswordHistoryRepository };
