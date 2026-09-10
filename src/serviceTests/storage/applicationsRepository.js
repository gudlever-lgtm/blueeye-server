'use strict';

const { bool, intOrNull } = require('./shape');

// Data-access for `service_test_applications` (migration 078) — the system under
// test. Deleting one cascades to its environments, credentials, allowlist, tests,
// runs and discoveries, which is why nothing here deletes those by hand.
function createApplicationsRepository({ db }) {
  const { pool } = db;
  const COLS = 'id,tenant_id,name,description,base_url,enabled,created_by,created_at,updated_at';

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      name: row.name,
      description: row.description,
      base_url: row.base_url,
      enabled: bool(row.enabled),
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async function list() {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_applications ORDER BY name`);
    return rows.map(shape);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_applications WHERE id = ?`, [id]);
    return shape(rows[0]);
  }

  async function create(input) {
    const [res] = await pool.query(
      `INSERT INTO service_test_applications (name, description, base_url, enabled, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [input.name, input.description ?? null, input.base_url, input.enabled === false ? 0 : 1, intOrNull(input.created_by)]
    );
    return findById(res.insertId);
  }

  // Partial update: only the fields present in `input` are written, so a PUT that
  // omits `enabled` does not silently re-enable a disabled application.
  async function update(id, input) {
    const sets = [];
    const params = [];
    for (const field of ['name', 'description', 'base_url']) {
      if (input[field] !== undefined) { sets.push(`${field} = ?`); params.push(input[field]); }
    }
    if (input.enabled !== undefined) { sets.push('enabled = ?'); params.push(input.enabled ? 1 : 0); }
    if (!sets.length) return findById(id);
    params.push(id);
    await pool.query(`UPDATE service_test_applications SET ${sets.join(', ')} WHERE id = ?`, params);
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM service_test_applications WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  return { list, findById, create, update, remove };
}

module.exports = { createApplicationsRepository };
