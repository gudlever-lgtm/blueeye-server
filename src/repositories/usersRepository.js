'use strict';

// Columns safe to return to API clients — never includes password_hash.
const PUBLIC_COLUMNS =
  'id, email, role, protected, must_change_password, temp_password_expires_at, temp_password_created_by, created_at, updated_at';

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
  // login flow (verify the password, then enforce the forced-change/expiry rules).
  async function findByEmailWithHash(email) {
    const [rows] = await pool.query(
      'SELECT id, email, password_hash, role, must_change_password, temp_password_expires_at, created_at, updated_at FROM users WHERE email = ?',
      [email]
    );
    const row = rows[0];
    if (!row) return null;
    return { ...row, must_change_password: row.must_change_password === 1 || row.must_change_password === true };
  }

  async function create({
    email,
    passwordHash,
    role,
    protected: isProtected = false,
    mustChangePassword = false,
    tempPasswordExpiresAt = null,
    tempPasswordCreatedBy = null,
  }) {
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, role, protected, must_change_password, temp_password_expires_at, temp_password_created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        email,
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

  // Patch may contain `email`, `role` and/or `passwordHash`. Returns the updated
  // row, or null if no user with that id exists.
  async function update(id, patch) {
    const existing = await findById(id);
    if (!existing) return null;

    const fields = [];
    const params = [];
    if (patch.email !== undefined) {
      fields.push('email = ?');
      params.push(patch.email);
    }
    if (patch.role !== undefined) {
      fields.push('role = ?');
      params.push(patch.role);
    }
    if (patch.passwordHash !== undefined) {
      fields.push('password_hash = ?');
      params.push(patch.passwordHash);
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
    updatePreferences,
  };
}

module.exports = { createUsersRepository };
