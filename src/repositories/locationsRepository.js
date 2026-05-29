'use strict';

const COLUMNS = 'id, name, description, created_at, updated_at';

// Data-access layer for the `locations` table. Factory style so the route
// handlers can be unit-tested with an in-memory fake instead of a real pool.
function createLocationsRepository(db) {
  const { pool } = db;

  async function findAll() {
    const [rows] = await pool.query(
      `SELECT ${COLUMNS} FROM locations ORDER BY id`
    );
    return rows;
  }

  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${COLUMNS} FROM locations WHERE id = ?`,
      [id]
    );
    return rows[0] ?? null;
  }

  async function create({ name, description = null }) {
    const [result] = await pool.query(
      'INSERT INTO locations (name, description) VALUES (?, ?)',
      [name, description]
    );
    return findById(result.insertId);
  }

  // Returns the updated row, or null if no row with that id exists.
  async function update(id, { name, description = null }) {
    const existing = await findById(id);
    if (!existing) return null;

    await pool.query(
      'UPDATE locations SET name = ?, description = ? WHERE id = ?',
      [name, description, id]
    );
    return findById(id);
  }

  // Returns true if a row was deleted, false if nothing matched the id.
  async function remove(id) {
    const [result] = await pool.query(
      'DELETE FROM locations WHERE id = ?',
      [id]
    );
    return result.affectedRows > 0;
  }

  return { findAll, findById, create, update, remove };
}

module.exports = { createLocationsRepository };
