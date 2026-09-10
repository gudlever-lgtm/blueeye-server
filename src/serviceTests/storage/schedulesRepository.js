'use strict';

const { bool, intOrNull } = require('./shape');

// Data-access for `service_test_schedules` (migration 078) — "run this test every
// N seconds against this environment". The scheduler asks for the DUE rows rather
// than loading everything and filtering in JS, so the query is the contract.
function createSchedulesRepository({ db, now = () => new Date() }) {
  const { pool } = db;
  const COLS = `id,tenant_id,test_id,environment_id,interval_sec,start_at,timezone,enabled,
    last_run_at,created_by,created_at,updated_at`;

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      test_id: row.test_id,
      environment_id: row.environment_id,
      interval_sec: row.interval_sec,
      start_at: row.start_at,
      timezone: row.timezone,
      enabled: bool(row.enabled),
      last_run_at: row.last_run_at,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_schedules WHERE id = ?`, [id]);
    return shape(rows[0]);
  }

  async function list({ testId = null } = {}) {
    const [rows] = testId === null
      ? await pool.query(`SELECT ${COLS} FROM service_test_schedules ORDER BY id`)
      : await pool.query(`SELECT ${COLS} FROM service_test_schedules WHERE test_id = ? ORDER BY id`, [testId]);
    return rows.map(shape);
  }

  // Enabled schedules whose interval has elapsed since last_run_at, and whose
  // start_at (if set) has arrived. A schedule that has never run is due as soon
  // as start_at passes — NOT immediately on creation when a start time was given.
  async function findDue(at = now()) {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_schedules
       WHERE enabled = 1
         AND (start_at IS NULL OR start_at <= ?)
         AND (last_run_at IS NULL OR last_run_at <= DATE_SUB(?, INTERVAL interval_sec SECOND))
       ORDER BY id`,
      [at, at]
    );
    return rows.map(shape);
  }

  async function create(input) {
    const [res] = await pool.query(
      `INSERT INTO service_test_schedules (test_id, environment_id, interval_sec, start_at, timezone, enabled, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.test_id, intOrNull(input.environment_id), input.interval_sec, input.start_at ?? null,
        input.timezone || 'UTC', input.enabled === false ? 0 : 1, intOrNull(input.created_by)]
    );
    return findById(res.insertId);
  }

  async function update(id, input) {
    const sets = [];
    const params = [];
    for (const field of ['interval_sec', 'start_at', 'timezone']) {
      if (input[field] !== undefined) { sets.push(`${field} = ?`); params.push(input[field]); }
    }
    if (input.environment_id !== undefined) { sets.push('environment_id = ?'); params.push(intOrNull(input.environment_id)); }
    if (input.enabled !== undefined) { sets.push('enabled = ?'); params.push(input.enabled ? 1 : 0); }
    if (!sets.length) return findById(id);
    params.push(id);
    await pool.query(`UPDATE service_test_schedules SET ${sets.join(', ')} WHERE id = ?`, params);
    return findById(id);
  }

  // Stamped when the scheduler enqueues a run, so a slow queue never causes the
  // same schedule to fire twice.
  async function markRun(id, at = now()) {
    await pool.query('UPDATE service_test_schedules SET last_run_at = ? WHERE id = ?', [at, id]);
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM service_test_schedules WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  return { findById, list, findDue, create, update, markRun, remove };
}

module.exports = { createSchedulesRepository };
