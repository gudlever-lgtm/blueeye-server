'use strict';

const { parseJson, intOrNull } = require('./shape');

// Data-access for `service_test_runs` + `service_test_run_steps` (migration 078).
//
// This table is ALSO the job queue. `claimNext()` is the load-bearing method: it
// takes the oldest queued run with a conditional UPDATE, so two workers racing
// for the same row produce one winner and one miss rather than two executions.
// There is no SELECT-then-UPDATE window anywhere in this file.
function createRunsRepository({ db, now = () => new Date() }) {
  const { pool } = db;
  const COLS = `id,tenant_id,test_id,environment_id,test_version,status,trigger_source,started_at,ended_at,
    duration_ms,failed_step,error_message,failure_kind,screenshot_path,browser,console_errors,network_errors,
    claimed_by,claimed_at,requested_by,created_at,updated_at`;

  function shape(row, steps = []) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      test_id: row.test_id,
      environment_id: row.environment_id,
      test_version: row.test_version,
      status: row.status,
      trigger_source: row.trigger_source,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_ms: row.duration_ms,
      failed_step: row.failed_step,
      error_message: row.error_message,
      failure_kind: row.failure_kind,
      screenshot_path: row.screenshot_path,
      browser: row.browser,
      console_errors: parseJson(row.console_errors, []),
      network_errors: parseJson(row.network_errors, []),
      claimed_by: row.claimed_by,
      claimed_at: row.claimed_at,
      requested_by: row.requested_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      steps,
    };
  }

  async function stepsFor(runId) {
    const [rows] = await pool.query(
      `SELECT id,run_id,position,step_type,label,status,duration_ms,message,detail
       FROM service_test_run_steps WHERE run_id = ? ORDER BY position`,
      [runId]
    );
    return rows.map((r) => ({ ...r, detail: parseJson(r.detail, null) }));
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_runs WHERE id = ?`, [id]);
    if (!rows[0]) return null;
    return shape(rows[0], await stepsFor(id));
  }

  // Filterable list for the Runs screen and the history strip. `limit` is clamped
  // here rather than trusted from the query string.
  async function list({ testId = null, status = null, limit = 50 } = {}) {
    const where = [];
    const params = [];
    if (testId !== null) { where.push('test_id = ?'); params.push(testId); }
    if (status !== null) { where.push('status = ?'); params.push(status); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const capped = Math.min(500, Math.max(1, Number(limit) || 50));
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_runs ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, capped]
    );
    return rows.map((r) => shape(r));
  }

  // Enqueue. Returns the queued run; the worker picks it up on its next poll.
  async function enqueue(input) {
    const [res] = await pool.query(
      `INSERT INTO service_test_runs (test_id, environment_id, test_version, status, trigger_source, requested_by)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
      [input.test_id, intOrNull(input.environment_id), intOrNull(input.test_version),
        input.trigger_source === 'schedule' ? 'schedule' : 'manual', intOrNull(input.requested_by)]
    );
    return findById(res.insertId);
  }

  // Atomically claim the oldest queued run for `workerId`. Returns the claimed
  // run, or null when another worker got there first / the queue is empty. The
  // UPDATE's `AND status='queued'` is what makes the claim safe; affectedRows
  // tells us whether we won.
  async function claimNext(workerId) {
    const [candidates] = await pool.query(
      "SELECT id FROM service_test_runs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1"
    );
    if (!candidates[0]) return null;
    const id = candidates[0].id;
    const at = now();
    const [res] = await pool.query(
      `UPDATE service_test_runs SET status = 'running', claimed_by = ?, claimed_at = ?, started_at = ?
       WHERE id = ? AND status = 'queued'`,
      [String(workerId).slice(0, 120), at, at, id]
    );
    if (!res.affectedRows) return null; // lost the race — the caller polls again
    return findById(id);
  }

  // Records the outcome and the per-step rows in one transaction, so a result is
  // never visible with half its steps.
  async function complete(id, result) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const endedAt = result.ended_at || now();
      await conn.query(
        `UPDATE service_test_runs SET status = ?, ended_at = ?, duration_ms = ?, failed_step = ?,
           error_message = ?, failure_kind = ?, screenshot_path = ?, browser = ?,
           console_errors = ?, network_errors = ?
         WHERE id = ?`,
        [result.status, endedAt, intOrNull(result.duration_ms), intOrNull(result.failed_step),
          result.error_message ?? null, result.failure_kind ?? null, result.screenshot_path ?? null,
          result.browser ?? null, JSON.stringify(result.console_errors || []),
          JSON.stringify(result.network_errors || []), id]
      );
      await conn.query('DELETE FROM service_test_run_steps WHERE run_id = ?', [id]);
      const steps = result.steps || [];
      for (let i = 0; i < steps.length; i += 1) {
        const s = steps[i];
        // eslint-disable-next-line no-await-in-loop
        await conn.query(
          `INSERT INTO service_test_run_steps (run_id, position, step_type, label, status, duration_ms, message, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, i, s.step_type || s.type || 'unknown', s.label ?? null, s.status,
            intOrNull(s.duration_ms), s.message ?? null, s.detail === undefined ? null : JSON.stringify(s.detail)]
        );
      }
      await conn.commit();
      return findById(id);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // Reaps runs a worker claimed but never finished (crash, container restart).
  // Bounded by the queue's claimTimeoutMs setting, passed in by the caller so the
  // repository holds no policy of its own.
  async function reapStale(claimTimeoutMs) {
    const cutoff = new Date(now().getTime() - claimTimeoutMs);
    const [res] = await pool.query(
      `UPDATE service_test_runs
         SET status = 'error', ended_at = ?, error_message = 'Run abandoned: the worker stopped responding'
       WHERE status = 'running' AND claimed_at IS NOT NULL AND claimed_at < ?`,
      [now(), cutoff]
    );
    return res.affectedRows;
  }

  // History strip for one test: the last N outcomes plus the aggregates the
  // History screen shows (success rate, average duration, last failure).
  async function history(testId, limit = 20) {
    const capped = Math.min(200, Math.max(1, Number(limit) || 20));
    const [rows] = await pool.query(
      `SELECT id,status,duration_ms,failed_step,error_message,started_at,ended_at
       FROM service_test_runs
       WHERE test_id = ? AND status NOT IN ('queued','running')
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [testId, capped]
    );
    const finished = rows.length;
    const passed = rows.filter((r) => r.status === 'pass').length;
    const durations = rows.map((r) => r.duration_ms).filter((d) => Number.isFinite(d));
    return {
      test_id: testId,
      runs: rows,
      total: finished,
      success_rate: finished ? passed / finished : null,
      avg_duration_ms: durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null,
      last_failure: rows.find((r) => r.status === 'fail' || r.status === 'error') || null,
    };
  }

  // Artefact retention: screenshot paths for runs older than `days`, so the
  // retention job can unlink the files before clearing the column.
  async function screenshotsOlderThan(days) {
    const cutoff = new Date(now().getTime() - days * 24 * 60 * 60 * 1000);
    const [rows] = await pool.query(
      'SELECT id, screenshot_path FROM service_test_runs WHERE screenshot_path IS NOT NULL AND created_at < ?',
      [cutoff]
    );
    return rows;
  }

  async function clearScreenshots(ids) {
    if (!ids || !ids.length) return 0;
    const [res] = await pool.query('UPDATE service_test_runs SET screenshot_path = NULL WHERE id IN (?)', [ids]);
    return res.affectedRows;
  }

  return {
    findById, list, enqueue, claimNext, complete, reapStale, history,
    screenshotsOlderThan, clearScreenshots,
  };
}

module.exports = { createRunsRepository };
