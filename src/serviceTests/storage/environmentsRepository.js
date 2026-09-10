'use strict';

const { bool } = require('./shape');

// Data-access for `service_test_environments` (migration 078) — the per-stage
// base URLs an application is tested against (production/staging/…).
function createEnvironmentsRepository({ db }) {
  const { pool } = db;
  const COLS = 'id,tenant_id,application_id,name,base_url,type,enabled,created_at,updated_at';

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      application_id: row.application_id,
      name: row.name,
      base_url: row.base_url,
      type: row.type,
      enabled: bool(row.enabled),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async function list({ applicationId = null } = {}) {
    if (applicationId === null) {
      const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_environments ORDER BY application_id, name`);
      return rows.map(shape);
    }
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_environments WHERE application_id = ? ORDER BY name`,
      [applicationId]
    );
    return rows.map(shape);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_environments WHERE id = ?`, [id]);
    return shape(rows[0]);
  }

  async function create(input) {
    const [res] = await pool.query(
      `INSERT INTO service_test_environments (application_id, name, base_url, type, enabled)
       VALUES (?, ?, ?, ?, ?)`,
      [input.application_id, input.name, input.base_url, input.type || 'custom', input.enabled === false ? 0 : 1]
    );
    return findById(res.insertId);
  }

  async function update(id, input) {
    const sets = [];
    const params = [];
    for (const field of ['name', 'base_url', 'type']) {
      if (input[field] !== undefined) { sets.push(`${field} = ?`); params.push(input[field]); }
    }
    if (input.enabled !== undefined) { sets.push('enabled = ?'); params.push(input.enabled ? 1 : 0); }
    if (!sets.length) return findById(id);
    params.push(id);
    await pool.query(`UPDATE service_test_environments SET ${sets.join(', ')} WHERE id = ?`, params);
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM service_test_environments WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  return { list, findById, create, update, remove };
}

module.exports = { createEnvironmentsRepository };
