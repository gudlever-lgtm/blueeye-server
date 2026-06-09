'use strict';

// Columns safe to return to API clients — never includes password_hash.
const PUBLIC_COLUMNS = 'id, email, role, protected, created_at, updated_at';

function mapRow(row) {
  if (!row) return null;
  return { ...row, protected: row.protected === 1 || row.protected === true };
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

  // Includes the password hash — used only by the login flow.
  async function findByEmailWithHash(email) {
    const [rows] = await pool.query(
      'SELECT id, email, password_hash, role, created_at, updated_at FROM users WHERE email = ?',
      [email]
    );
    return rows[0] ?? null;
  }

  async function create({ email, passwordHash, role, protected: isProtected = false }) {
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, role, protected) VALUES (?, ?, ?, ?)',
      [email, passwordHash, role, isProtected ? 1 : 0]
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
    countByRole,
    getPreferences,
    updatePreferences,
  };
}

module.exports = { createUsersRepository };
