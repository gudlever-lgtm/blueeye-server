'use strict';

const { CLEARED_FINGERPRINT } = require('../license/keyIdentity');

// Data-access for `trust_key_identity` (migration 140) — one row per trust-key
// kind, holding the fingerprint this server has been running with.
//
// The writes are deliberately narrow. Nothing here decides anything; the verdict
// lives in src/license/keyIdentity.js, and this only persists what that decided.
function createTrustKeyIdentityRepository(db) {
  const { pool } = db;

  async function get(kind) {
    const [rows] = await pool.query('SELECT * FROM trust_key_identity WHERE kind = ? LIMIT 1', [kind]);
    return rows[0] ?? null;
  }

  async function list() {
    const [rows] = await pool.query('SELECT * FROM trust_key_identity ORDER BY kind');
    return rows;
  }

  // First sighting of a key for this kind. Idempotent under a race: two workers
  // booting together must not turn one key into a "change".
  async function record({ kind, fingerprint, firstSeenAt }) {
    await pool.query(
      `INSERT INTO trust_key_identity (kind, fingerprint, first_seen_at, change_count)
       VALUES (?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE fingerprint = VALUES(fingerprint)`,
      [kind, fingerprint, firstSeenAt]
    );
    return get(kind);
  }

  // The key moved. The new value becomes the record, the old one is kept so the
  // warning can name both, and the counter goes up — a key that has moved twice
  // is a different story from one that moved once.
  //
  // `fingerprint` is NULL-able in the caller's world ('cleared'), but the column
  // is NOT NULL, so a cleared key is stored as CLEARED_FINGERPRINT — 64 zeroes, a
  // value no SHA-256 of a real PEM produces. keyIdentity.js reads the row back
  // through the same constant, so delete-then-generate is judged against the last
  // REAL key (previous_fingerprint) rather than against the sentinel.

  async function recordChange({ kind, fingerprint, previous, changedAt }) {
    await pool.query(
      `INSERT INTO trust_key_identity (kind, fingerprint, previous_fingerprint, first_seen_at, changed_at, change_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         fingerprint = VALUES(fingerprint),
         previous_fingerprint = VALUES(previous_fingerprint),
         changed_at = VALUES(changed_at),
         change_count = change_count + 1,
         -- A change is never born acknowledged: whatever an admin signed off on
         -- before was a different value.
         acknowledged_fingerprint = NULL,
         acknowledged_at = NULL,
         acknowledged_by = NULL`,
      [kind, fingerprint || CLEARED_FINGERPRINT, previous || null, changedAt, changedAt]
    );
    return get(kind);
  }

  // An admin has seen the warning and accepts this value. Stored as the
  // fingerprint acknowledged (not a flag), so the next change is loud again.
  async function acknowledge({ kind, fingerprint, at, userId = null }) {
    await pool.query(
      `UPDATE trust_key_identity
          SET acknowledged_fingerprint = ?, acknowledged_at = ?, acknowledged_by = ?
        WHERE kind = ?`,
      [fingerprint, at, userId, kind]
    );
    return get(kind);
  }

  return { get, list, record, recordChange, acknowledge };
}

module.exports = { createTrustKeyIdentityRepository };
