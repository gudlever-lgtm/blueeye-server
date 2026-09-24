'use strict';

// Columns safe to return to API clients — never includes password_hash.
const PUBLIC_COLUMNS =
  'id, email, name, role, protected, must_change_password, temp_password_expires_at, temp_password_created_by, created_at, updated_at';

function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    protected: row.protected === 1 || row.protected === true,
    must_change_password: row.must_change_password === 1 || row.must_change_password === true,
  };
}

// `preferences` is a JSON column. mysql2 usually returns it already parsed, but
// tolerate a string (or bad JSON) and always hand callers a plain object.
function parsePreferences(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

// Data-access layer for the `users` table.
// How long a Changes-page acknowledgement lasts (migration 115). Matches the
// route's MAX_WINDOW_MS: past it, no window can show the row it was about.
const CHANGE_ACK_TTL_DAYS = 30;

function createUsersRepository(db) {
  const { pool } = db;

  async function findAll() {
    const [rows] = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY id`
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`,
      [id]
    );
    return mapRow(rows[0]) ?? null;
  }

  async function findByEmail(email) {
    const [rows] = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM users WHERE email = ?`,
      [email]
    );
    return mapRow(rows[0]) ?? null;
  }

  // Includes the password hash + one-time-password state — used only by the
  // login flow (verify the password, then enforce the forced-change/expiry rules)
  // and the password-history checks. `password_changed_at` (migration 041)
  // drives the opt-in password max age.
  async function findByEmailWithHash(email) {
    const [rows] = await pool.query(
      'SELECT id, email, password_hash, password_changed_at, role, must_change_password, temp_password_expires_at, created_at, updated_at FROM users WHERE email = ?',
      [email]
    );
    const row = rows[0];
    if (!row) return null;
    return { ...row, must_change_password: row.must_change_password === 1 || row.must_change_password === true };
  }

  async function create({
    email,
    name = null,
    passwordHash,
    role,
    protected: isProtected = false,
    mustChangePassword = false,
    tempPasswordExpiresAt = null,
    tempPasswordCreatedBy = null,
  }) {
    // password_changed_at (migration 041) is stamped on every write of
    // password_hash in this file, so the max-age clock always starts at the
    // password actually in use.
    const [result] = await pool.query(
      'INSERT INTO users (email, name, password_hash, password_changed_at, role, protected, must_change_password, temp_password_expires_at, temp_password_created_by) VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?)',
      [
        email,
        name,
        passwordHash,
        role,
        isProtected ? 1 : 0,
        mustChangePassword ? 1 : 0,
        tempPasswordExpiresAt,
        tempPasswordCreatedBy,
      ]
    );
    return findById(result.insertId);
  }

  // Patch may contain `email`, `name`, `role` and/or `passwordHash`. Returns the
  // updated row, or null if no user with that id exists. `name` is display text:
  // an empty string clears it back to NULL rather than storing a blank label.
  async function update(id, patch) {
    const existing = await findById(id);
    if (!existing) return null;

    const fields = [];
    const params = [];
    if (patch.email !== undefined) {
      fields.push('email = ?');
      params.push(patch.email);
    }
    if (patch.name !== undefined) {
      fields.push('name = ?');
      params.push(patch.name === null || patch.name === '' ? null : patch.name);
    }
    if (patch.role !== undefined) {
      fields.push('role = ?');
      params.push(patch.role);
    }
    if (patch.passwordHash !== undefined) {
      fields.push('password_hash = ?');
      params.push(patch.passwordHash);
      fields.push('password_changed_at = NOW()');
    }

    // A role or password change must invalidate any tokens issued earlier (the
    // user is being deprovisioned, locked out, or having their access narrowed).
    if (patch.role !== undefined || patch.passwordHash !== undefined) {
      fields.push('tokens_valid_after = NOW()');
    }

    if (fields.length > 0) {
      params.push(id);
      await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    return findById(id);
  }

  async function remove(id) {
    const [result] = await pool.query('DELETE FROM users WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  // Issues (or re-issues) a one-time password: replaces the hash, flags the user
  // for a forced change, sets the new expiry and issuing admin, and revokes any
  // JWTs already outstanding (tokens_valid_after) so an old session can't skip
  // the change. Returns the updated public row, or null if the user is gone.
  async function setTempPassword(id, { passwordHash, expiresAt, createdBy = null }) {
    const [result] = await pool.query(
      `UPDATE users
          SET password_hash = ?,
              password_changed_at = NOW(),
              must_change_password = 1,
              temp_password_expires_at = ?,
              temp_password_created_by = ?,
              tokens_valid_after = NOW()
        WHERE id = ?`,
      [passwordHash, expiresAt, createdBy, id]
    );
    if (result.affectedRows === 0) return null;
    return findById(id);
  }

  // Completes a forced change: stores the new (policy-checked) hash, clears the
  // one-time-password flags, and revokes older tokens. Returns the updated public
  // row, or null if the user is gone.
  async function clearTempPassword(id, passwordHash) {
    const [result] = await pool.query(
      `UPDATE users
          SET password_hash = ?,
              password_changed_at = NOW(),
              must_change_password = 0,
              temp_password_expires_at = NULL,
              temp_password_created_by = NULL,
              tokens_valid_after = NOW()
        WHERE id = ?`,
      [passwordHash, id]
    );
    if (result.affectedRows === 0) return null;
    return findById(id);
  }

  // Users with a token-revocation cutoff set — loaded by the revocation registry
  // so requireAuth can reject pre-cutoff tokens without a per-request DB read.
  async function findRevocations() {
    const [rows] = await pool.query(
      'SELECT id, tokens_valid_after FROM users WHERE tokens_valid_after IS NOT NULL'
    );
    return rows;
  }

  async function countByRole(role) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS count FROM users WHERE role = ?',
      [role]
    );
    return Number(rows[0].count);
  }

  // Per-user UI preferences (e.g. the dashboard colour theme). Returns a plain
  // object, {} when none are stored or the user no longer exists.
  async function getPreferences(id) {
    const [rows] = await pool.query('SELECT preferences FROM users WHERE id = ?', [id]);
    return rows[0] ? parsePreferences(rows[0].preferences) : {};
  }

  // Merge-update: only the supplied keys change, so a partial PUT never clobbers
  // other preferences. Returns the full, updated preferences object.
  async function updatePreferences(id, patch) {
    const current = await getPreferences(id);
    const next = { ...current, ...patch };
    await pool.query('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(next), id]);
    return next;
  }

  // The per-user "changes seen up to here" marker (migration 074). Returns a
  // Date or null (never marked).
  async function getLastSeenChanges(id) {
    const [rows] = await pool.query('SELECT last_seen_changes FROM users WHERE id = ?', [id]);
    if (!rows[0] || rows[0].last_seen_changes == null) return null;
    const v = rows[0].last_seen_changes;
    return v instanceof Date ? v : new Date(v);
  }

  // Moves the marker forward. Deliberately monotonic: `GREATEST` with the stored
  // value means a stale tab marking an OLD timestamp as seen can never rewind
  // someone's position and re-surface changes they already dealt with.
  async function setLastSeenChanges(id, at) {
    const [res] = await pool.query(
      'UPDATE users SET last_seen_changes = GREATEST(COALESCE(last_seen_changes, ?), ?) WHERE id = ?',
      [at, at, id]
    );
    return res.affectedRows > 0;
  }

  // Per-user acknowledgements on the Changes page (migration 115). Keyed by the
  // feed row's ackKey; older than CHANGE_ACK_TTL_DAYS is treated as gone, which
  // is also the longest window the page can show.
  //
  // Returns Map<ackKey, Date>.
  async function listChangeAcks(userId) {
    const [rows] = await pool.query(
      `SELECT ack_key, acked_at FROM change_acks
        WHERE user_id = ? AND acked_at >= (NOW(3) - INTERVAL ${CHANGE_ACK_TTL_DAYS} DAY)`,
      [userId]
    );
    const out = new Map();
    for (const r of rows) out.set(String(r.ack_key), r.acked_at instanceof Date ? r.acked_at : new Date(r.acked_at));
    return out;
  }

  // Acknowledges (or re-acknowledges, moving the time forward) one row, and
  // prunes this user's expired acknowledgements on the way, so the table stays
  // bounded without a sweep of its own.
  async function ackChange(userId, key, at) {
    await pool.query(
      'INSERT INTO change_acks (user_id, ack_key, acked_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE acked_at = VALUES(acked_at)',
      [userId, key, at]
    );
    await pool.query(
      `DELETE FROM change_acks WHERE user_id = ? AND acked_at < (NOW(3) - INTERVAL ${CHANGE_ACK_TTL_DAYS} DAY)`,
      [userId]
    );
    return at;
  }

  // Undo. True when there was an acknowledgement to remove.
  async function unackChange(userId, key) {
    const [res] = await pool.query('DELETE FROM change_acks WHERE user_id = ? AND ack_key = ?', [userId, key]);
    return res.affectedRows > 0;
  }

  return {
    findAll,
    findById,
    findByEmail,
    findByEmailWithHash,
    create,
    update,
    remove,
    setTempPassword,
    clearTempPassword,
    findRevocations,
    countByRole,
    getPreferences,
    getLastSeenChanges,
    setLastSeenChanges,
    listChangeAcks,
    ackChange,
    unackChange,
    updatePreferences,
  };
}

module.exports = { createUsersRepository, CHANGE_ACK_TTL_DAYS };
