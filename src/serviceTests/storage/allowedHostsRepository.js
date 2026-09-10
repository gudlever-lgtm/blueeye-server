'use strict';

const { intOrNull } = require('./shape');

// Data-access for `service_test_allowed_hosts` (migration 078) — the per-
// application SSRF escape hatch. This layer stores and reads rows; it does NOT
// decide whether an entry is permissible. That judgement (deny-list overlap,
// prefix floor, address cap) belongs to security/hostPolicy.js, which runs
// before anything reaches here — a repository that also validated would give
// callers two places to look and one to forget.
function createAllowedHostsRepository({ db }) {
  const { pool } = db;
  const COLS = 'id,tenant_id,application_id,entry_type,value,note,created_by,created_at,updated_at';

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      application_id: row.application_id,
      entry_type: row.entry_type,
      value: row.value,
      note: row.note,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async function listForApplication(applicationId) {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_allowed_hosts WHERE application_id = ? ORDER BY entry_type, value`,
      [applicationId]
    );
    return rows.map(shape);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_allowed_hosts WHERE id = ?`, [id]);
    return shape(rows[0]);
  }

  // Idempotent by (application_id, value): re-adding an existing entry updates
  // its note instead of failing on the unique key, so a re-imported list is a
  // no-op rather than an error.
  async function add(input) {
    await pool.query(
      `INSERT INTO service_test_allowed_hosts (application_id, entry_type, value, note, created_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE entry_type = VALUES(entry_type), note = VALUES(note)`,
      [input.application_id, input.entry_type, input.value, input.note ?? null, intOrNull(input.created_by)]
    );
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_allowed_hosts WHERE application_id = ? AND value = ?`,
      [input.application_id, input.value]
    );
    return shape(rows[0]);
  }

  // Bulk add for the CSV/line-list import. Sequential rather than one multi-row
  // INSERT so a per-entry note update still applies; import size is capped well
  // below where that matters.
  async function addMany(applicationId, entries, createdBy = null) {
    const out = [];
    for (const e of entries || []) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await add({ ...e, application_id: applicationId, created_by: createdBy }));
    }
    return out;
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM service_test_allowed_hosts WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  async function removeAllForApplication(applicationId) {
    const [res] = await pool.query('DELETE FROM service_test_allowed_hosts WHERE application_id = ?', [applicationId]);
    return res.affectedRows;
  }

  return { listForApplication, findById, add, addMany, remove, removeAllForApplication };
}

module.exports = { createAllowedHostsRepository };
