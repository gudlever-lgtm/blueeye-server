'use strict';

const COLUMNS = 'id, name, description, address, latitude, longitude, created_at, updated_at';

// Coordinates come back as strings from DECIMAL columns; expose them as numbers.
function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
  };
}

// Data-access layer for the `locations` table. Factory style so the route
// handlers can be unit-tested with an in-memory fake instead of a real pool.
function createLocationsRepository(db) {
  const { pool } = db;

  async function findAll() {
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM locations ORDER BY id`);
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM locations WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  async function create({ name, description = null, address = null, latitude = null, longitude = null }) {
    const [result] = await pool.query(
      'INSERT INTO locations (name, description, address, latitude, longitude) VALUES (?, ?, ?, ?, ?)',
      [name, description, address, latitude, longitude]
    );
    return findById(result.insertId);
  }

  // Returns the updated row, or null if no row with that id exists.
  async function update(id, { name, description = null, address = null, latitude = null, longitude = null }) {
    const existing = await findById(id);
    if (!existing) return null;

    await pool.query(
      'UPDATE locations SET name = ?, description = ?, address = ?, latitude = ?, longitude = ? WHERE id = ?',
      [name, description, address, latitude, longitude, id]
    );
    return findById(id);
  }

  // Returns true if a row was deleted, false if nothing matched the id.
  async function remove(id) {
    const [result] = await pool.query('DELETE FROM locations WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  return { findAll, findById, create, update, remove };
}

module.exports = { createLocationsRepository };
