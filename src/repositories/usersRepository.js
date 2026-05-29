'use strict';

// Columns safe to return to API clients — never includes password_hash.
const PUBLIC_COLUMNS = 'id, email, role, created_at, updated_at';

// Data-access layer for the `users` table.
function createUsersRepository(db) {
  const { pool } = db;

  async function findAll() {
    const [rows] = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY id`
    );
    return rows;
  }

  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`,
      [id]
    );
    return rows[0] ?? null;
  }

  async function findByEmail(email) {
    const [rows] = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM users WHERE email = ?`,
      [email]
    );
    return rows[0] ?? null;
  }

  // Includes the password hash — used only by the login flow.
  async function findByEmailWithHash(email) {
    const [rows] = await pool.query(
      'SELECT id, email, password_hash, role, created_at, updated_at FROM users WHERE email = ?',
      [email]
    );
    return rows[0] ?? null;
  }

  async function create({ email, passwordHash, role }) {
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
      [email, passwordHash, role]
    );
    return findById(result.insertId);
  }

  // Patch may contain `role` and/or `passwordHash`. Returns the updated row,
  // or null if no user with that id exists.
  async function update(id, patch) {
    const existing = await findById(id);
    if (!existing) return null;

    const fields = [];
    const params = [];
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

  return {
    findAll,
    findById,
    findByEmail,
    findByEmailWithHash,
    create,
    update,
    remove,
    countByRole,
  };
}

module.exports = { createUsersRepository };
