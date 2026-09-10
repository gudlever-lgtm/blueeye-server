'use strict';

const { parseJson, bool, intOrNull } = require('./shape');

// Data-access for `service_test_tests` + `service_test_test_steps` +
// `service_test_test_versions` (migration 078).
//
// `definition` (the neutral DSL) is the source of truth for EXECUTION; the step
// rows are what the drag & drop designer reads and reorders. save() writes both
// in one transaction and snapshots the previous definition into the versions
// table, so a save is never half-applied and history is never lost (spec §38).
function createTestsRepository({ db }) {
  const { pool } = db;
  const COLS = 'id,tenant_id,application_id,name,description,definition,version,credential_id,enabled,created_by,created_at,updated_at';

  function shape(row, steps = []) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      application_id: row.application_id,
      name: row.name,
      description: row.description,
      definition: parseJson(row.definition, { version: 1, steps: [] }),
      version: row.version,
      credential_id: row.credential_id,
      enabled: bool(row.enabled),
      steps,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function shapeStep(row) {
    return {
      id: row.id,
      test_id: row.test_id,
      position: row.position,
      step_type: row.step_type,
      label: row.label,
      config: parseJson(row.config, {}),
      enabled: bool(row.enabled),
    };
  }

  async function stepsFor(testId, conn = pool) {
    const [rows] = await conn.query(
      'SELECT id,test_id,position,step_type,label,config,enabled FROM service_test_test_steps WHERE test_id = ? ORDER BY position',
      [testId]
    );
    return rows.map(shapeStep);
  }

  async function list({ applicationId = null } = {}) {
    const [rows] = applicationId === null
      ? await pool.query(`SELECT ${COLS} FROM service_test_tests ORDER BY name`)
      : await pool.query(`SELECT ${COLS} FROM service_test_tests WHERE application_id = ? ORDER BY name`, [applicationId]);
    // List view does not need step rows — the definition carries the step count.
    return rows.map((r) => shape(r));
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_tests WHERE id = ?`, [id]);
    if (!rows[0]) return null;
    return shape(rows[0], await stepsFor(id));
  }

  // Rewrites the step rows for a test to exactly `steps`, in array order. Called
  // inside save()'s transaction; positions are assigned here so the caller never
  // has to keep them consistent.
  async function writeSteps(conn, testId, steps) {
    await conn.query('DELETE FROM service_test_test_steps WHERE test_id = ?', [testId]);
    for (let i = 0; i < (steps || []).length; i += 1) {
      const s = steps[i] || {};
      // eslint-disable-next-line no-await-in-loop
      await conn.query(
        `INSERT INTO service_test_test_steps (test_id, position, step_type, label, config, enabled)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [testId, i, s.type || s.step_type || 'unknown', s.label ?? null, JSON.stringify(s.config ?? s), s.enabled === false ? 0 : 1]
      );
    }
  }

  async function create(input) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const definition = input.definition || { version: 1, name: input.name, steps: [] };
      const [res] = await conn.query(
        `INSERT INTO service_test_tests (application_id, name, description, definition, version, credential_id, enabled, created_by)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        [input.application_id, input.name, input.description ?? null, JSON.stringify(definition),
          intOrNull(input.credential_id), input.enabled === false ? 0 : 1, intOrNull(input.created_by)]
      );
      const id = res.insertId;
      await writeSteps(conn, id, definition.steps);
      await conn.query(
        'INSERT INTO service_test_test_versions (test_id, version, definition, created_by) VALUES (?, 1, ?, ?)',
        [id, JSON.stringify(definition), intOrNull(input.created_by)]
      );
      await conn.commit();
      return findById(id);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // Saves a new revision: bumps `version`, snapshots the NEW definition into the
  // versions table and rewrites the step rows — all or nothing.
  async function save(id, input) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT version, definition FROM service_test_tests WHERE id = ? FOR UPDATE', [id]);
      if (!rows[0]) { await conn.rollback(); return null; }
      const nextVersion = rows[0].version + 1;
      const definition = input.definition || parseJson(rows[0].definition, { version: 1, steps: [] });

      const sets = ['definition = ?', 'version = ?'];
      const params = [JSON.stringify(definition), nextVersion];
      for (const field of ['name', 'description']) {
        if (input[field] !== undefined) { sets.push(`${field} = ?`); params.push(input[field]); }
      }
      if (input.credential_id !== undefined) { sets.push('credential_id = ?'); params.push(intOrNull(input.credential_id)); }
      if (input.enabled !== undefined) { sets.push('enabled = ?'); params.push(input.enabled ? 1 : 0); }
      params.push(id);
      await conn.query(`UPDATE service_test_tests SET ${sets.join(', ')} WHERE id = ?`, params);
      await writeSteps(conn, id, definition.steps);
      await conn.query(
        'INSERT INTO service_test_test_versions (test_id, version, definition, created_by) VALUES (?, ?, ?, ?)',
        [id, nextVersion, JSON.stringify(definition), intOrNull(input.updated_by)]
      );
      await conn.commit();
      return findById(id);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async function versions(testId) {
    const [rows] = await pool.query(
      'SELECT id,test_id,version,definition,created_by,created_at FROM service_test_test_versions WHERE test_id = ? ORDER BY version DESC',
      [testId]
    );
    return rows.map((r) => ({ ...r, definition: parseJson(r.definition, null) }));
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM service_test_tests WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  return { list, findById, create, save, versions, remove };
}

module.exports = { createTestsRepository };
