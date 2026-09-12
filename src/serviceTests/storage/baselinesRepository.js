'use strict';

const { numOrNull } = require('./shape');

// Data access for `service_test_baselines` (migration 088).
//
// A baseline is "this is what this step is supposed to look like", per test,
// step and environment. The IMAGE is on disk under the artifact root; this
// stores the path, the ignore regions, the tuning and who accepted it.
function createBaselinesRepository({ db, now = () => new Date() }) {
  const { pool } = db;

  const COLS = `id, test_id, step_index, step_label, environment_id, image_path,
    width, height, ignore_regions, tolerance, threshold_pct, enabled,
    accepted_by, accepted_at, source_run_id, created_at, updated_at`;

  function parseJson(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      test_id: row.test_id,
      step_index: row.step_index,
      step_label: row.step_label,
      environment_id: row.environment_id,
      image_path: row.image_path,
      width: row.width,
      height: row.height,
      ignore_regions: parseJson(row.ignore_regions, []) || [],
      tolerance: row.tolerance === null ? null : Number(row.tolerance),
      // DECIMAL comes back as a string from mysql2; a caller comparing it to a
      // number would silently always disagree.
      threshold_pct: row.threshold_pct === null ? null : Number(row.threshold_pct),
      enabled: row.enabled === 1 || row.enabled === true,
      accepted_by: row.accepted_by,
      accepted_at: row.accepted_at,
      source_run_id: row.source_run_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_baselines WHERE id = ? LIMIT 1`, [id]);
    return shape(rows[0]);
  }

  async function listForTest(testId, { enabledOnly = false } = {}) {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_baselines
       WHERE test_id = ? ${enabledOnly ? 'AND enabled = 1' : ''}
       ORDER BY step_index, environment_id`,
      [testId]
    );
    return rows.map(shape);
  }

  // The baselines a run should compare against.
  //
  // An environment-specific baseline wins over the environment-less one for the
  // same step: the general one is a fallback for "this test only ever runs in
  // one place", and a specific one is somebody saying this environment looks
  // different on purpose.
  async function forRun(testId, environmentId) {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_baselines
       WHERE test_id = ? AND enabled = 1 AND (environment_id = ? OR environment_id IS NULL)
       ORDER BY step_index, environment_id IS NULL`,
      [testId, numOrNull(environmentId)]
    );
    const byStep = new Map();
    for (const row of rows.map(shape)) {
      if (!byStep.has(row.step_index)) byStep.set(row.step_index, row);
    }
    return [...byStep.values()];
  }

  // Accepting a baseline REPLACES whatever was there for that step and
  // environment. "Accept this as the new normal" is one act, not delete-then-
  // create, and doing it in two statements would leave a window where the step
  // is watching nothing.
  async function accept(input) {
    await pool.query(
      `INSERT INTO service_test_baselines
         (test_id, step_index, step_label, environment_id, image_path, width, height,
          ignore_regions, tolerance, threshold_pct, enabled, accepted_by, accepted_at, source_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         image_path = VALUES(image_path), width = VALUES(width), height = VALUES(height),
         step_label = VALUES(step_label), enabled = 1,
         accepted_by = VALUES(accepted_by), accepted_at = VALUES(accepted_at),
         source_run_id = VALUES(source_run_id)`,
      [
        numOrNull(input.test_id), numOrNull(input.step_index), input.step_label ?? null,
        numOrNull(input.environment_id), input.image_path,
        numOrNull(input.width), numOrNull(input.height),
        input.ignore_regions ? JSON.stringify(input.ignore_regions) : null,
        numOrNull(input.tolerance), numOrNull(input.threshold_pct),
        numOrNull(input.accepted_by), now(), numOrNull(input.source_run_id),
      ]
    );
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_baselines
       WHERE test_id = ? AND step_index = ? AND environment_id <=> ? LIMIT 1`,
      [numOrNull(input.test_id), numOrNull(input.step_index), numOrNull(input.environment_id)]
    );
    return shape(rows[0]);
  }

  // Ignore regions, tuning and the on/off switch. Deliberately NOT the image:
  // replacing what the page should look like is `accept`, which records who did
  // it and when. Letting an edit swap the picture would lose that.
  async function save(id, input) {
    const sets = [];
    const params = [];
    if (input.ignore_regions !== undefined) {
      sets.push('ignore_regions = ?');
      params.push(input.ignore_regions ? JSON.stringify(input.ignore_regions) : null);
    }
    for (const field of ['tolerance', 'threshold_pct']) {
      if (input[field] !== undefined) { sets.push(`${field} = ?`); params.push(numOrNull(input[field])); }
    }
    if (input.enabled !== undefined) { sets.push('enabled = ?'); params.push(input.enabled ? 1 : 0); }
    if (!sets.length) return findById(id);
    params.push(id);
    const [res] = await pool.query(`UPDATE service_test_baselines SET ${sets.join(', ')} WHERE id = ?`, params);
    if (!res.affectedRows) return null;
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM service_test_baselines WHERE id = ?', [id]);
    return (res.affectedRows || 0) > 0;
  }

  return { findById, listForTest, forRun, accept, save, remove };
}

module.exports = { createBaselinesRepository };
