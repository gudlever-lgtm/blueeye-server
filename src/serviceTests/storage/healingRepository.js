'use strict';

const { parseJson, intOrNull } = require('./shape');

// Data-access for `service_test_healing` (migration 085).
//
// A healing proposal is a row somebody has to act on, never a change that
// happened on its own. This repository is therefore written so that nothing in
// it can modify a test: it records proposals and decisions, and the API layer is
// the only place a definition is rewritten — and only after an operator says so.
function createHealingRepository({ db, now = () => new Date() }) {
  const { pool } = db;

  const COLS = `id, tenant_id, test_id, run_id, step_path, step_type,
    original_target, proposed_target, confidence, reason, score, status,
    applied_by, decided_at, created_at, updated_at`;
  const H_COLS = COLS.split(',').map((c) => `h.${c.trim()}`).join(', ');
  const WITH_TEST = `SELECT ${H_COLS}, t.name AS test_name, t.application_id AS application_id,
      a.name AS application_name
    FROM service_test_healing h
    LEFT JOIN service_test_tests t ON t.id = h.test_id
    LEFT JOIN service_test_applications a ON a.id = t.application_id`;

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      test_id: row.test_id,
      test_name: row.test_name ?? null,
      application_id: row.application_id ?? null,
      application_name: row.application_name ?? null,
      run_id: row.run_id,
      step_path: row.step_path,
      step_type: row.step_type,
      original_target: parseJson(row.original_target, null),
      proposed_target: parseJson(row.proposed_target, null),
      confidence: row.confidence,
      reason: row.reason,
      score: row.score,
      status: row.status,
      applied_by: row.applied_by,
      decided_at: row.decided_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async function findById(id) {
    const [rows] = await pool.query(`${WITH_TEST} WHERE h.id = ? LIMIT 1`, [id]);
    return shape(rows[0]);
  }

  // Records a proposal, unless the same one is already waiting.
  //
  // A test that fails every five minutes would otherwise pile up three hundred
  // identical proposals a day, and the operator would stop reading them — which
  // is the same as not proposing at all. One open proposal per (test, step,
  // proposed target); a later run refreshes its run_id and reason so the
  // operator always reads the newest evidence for it.
  async function propose(input) {
    const testId = intOrNull(input.test_id);
    const stepPath = input.step_path == null ? null : String(input.step_path).slice(0, 40);
    if (testId === null || !stepPath) return null;
    const proposed = JSON.stringify(input.proposed_target || null);

    const [existing] = await pool.query(
      `SELECT id FROM service_test_healing
        WHERE test_id = ? AND step_path = ? AND status = 'proposed'
          AND CAST(proposed_target AS CHAR) = CAST(? AS CHAR)
        LIMIT 1`,
      [testId, stepPath, proposed]
    );
    if (existing[0]) {
      await pool.query(
        'UPDATE service_test_healing SET run_id = ?, reason = ?, confidence = ?, score = ? WHERE id = ?',
        [intOrNull(input.run_id), input.reason ?? null, input.confidence || 'low',
          intOrNull(input.score), existing[0].id]
      );
      return findById(existing[0].id);
    }

    const [res] = await pool.query(
      `INSERT INTO service_test_healing
         (test_id, run_id, step_path, step_type, original_target, proposed_target, confidence, reason, score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [testId, intOrNull(input.run_id), stepPath, input.step_type ?? null,
        JSON.stringify(input.original_target || null), proposed,
        input.confidence || 'low', input.reason ?? null, intOrNull(input.score)]
    );
    return findById(res.insertId);
  }

  async function list({ testId = null, status = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (testId) { where.push('h.test_id = ?'); params.push(testId); }
    if (status) { where.push('h.status = ?'); params.push(status); }
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const [rows] = await pool.query(
      `${WITH_TEST} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY FIELD(h.status, 'proposed', 'accepted', 'rejected', 'stale'), h.id DESC
       LIMIT ${n}`,
      params
    );
    return rows.map(shape);
  }

  // The decision. One-way, like accepting a suggestion: a proposal that has been
  // acted on is history, and re-deciding it would lose the record of what was
  // decided the first time.
  async function decide(id, status, userId = null) {
    const [res] = await pool.query(
      `UPDATE service_test_healing SET status = ?, applied_by = ?, decided_at = ?
        WHERE id = ? AND status = 'proposed'`,
      [status, intOrNull(userId), now(), id]
    );
    if (!res.affectedRows) return null;
    return findById(id);
  }

  // Marks the other open proposals for the same step stale once one is accepted:
  // they were alternatives to a question that has been answered.
  async function markOthersStale(testId, stepPath, keepId) {
    const [res] = await pool.query(
      `UPDATE service_test_healing SET status = 'stale'
        WHERE test_id = ? AND step_path = ? AND status = 'proposed' AND id <> ?`,
      // A path, not an integer: intOrNull("2.1") is null, which would match no
      // row and silently leave the alternatives open beside an accepted heal.
      [intOrNull(testId), String(stepPath), intOrNull(keepId)]
    );
    return res.affectedRows || 0;
  }

  // Open proposals per test, for the badge on the tests list.
  async function openCounts() {
    const [rows] = await pool.query(
      "SELECT test_id, COUNT(*) AS n FROM service_test_healing WHERE status = 'proposed' GROUP BY test_id"
    );
    return new Map(rows.map((r) => [r.test_id, Number(r.n)]));
  }

  return { findById, propose, list, decide, markOthersStale, openCounts };
}

module.exports = { createHealingRepository };
