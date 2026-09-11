'use strict';

// Data-access for `service_test_journeys` + `service_test_journey_steps`
// (migration 083).
//
// A journey orders tests that already exist. It owns no steps of its own and no
// DSL, so this repository never touches a definition — it reads membership, and
// the LATEST RUN of each member, which is what the health rollup needs and the
// only genuinely awkward query here.
function createJourneysRepository({ db, now = () => new Date() }) {
  const { pool } = db;

  const COLS = `id, tenant_id, application_id, name, description, criticality,
    expected_duration_ms, environment_id, enabled, created_by, updated_by, created_at, updated_at`;
  const J_COLS = COLS.split(',').map((c) => `j.${c.trim()}`).join(', ');
  // Same reasoning as the tests list: a journey's name is only unique within its
  // application, so every read that feeds a list carries the application name.
  const WITH_APP = `SELECT ${J_COLS}, a.name AS application_name, e.name AS environment_name
    FROM service_test_journeys j
    LEFT JOIN service_test_applications a ON a.id = j.application_id
    LEFT JOIN service_test_environments e ON e.id = j.environment_id`;

  const intOrNull = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) ? n : null;
  };

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      application_id: row.application_id,
      application_name: row.application_name ?? null,
      name: row.name,
      description: row.description,
      criticality: row.criticality,
      expected_duration_ms: row.expected_duration_ms,
      environment_id: row.environment_id,
      environment_name: row.environment_name ?? null,
      enabled: row.enabled === 1 || row.enabled === true,
      created_by: row.created_by,
      updated_by: row.updated_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // A step, with the test it points at and that test's LATEST run.
  //
  // The latest run is found with a correlated subquery on MAX(id) rather than a
  // window function: `id` is the autoincrement, so the newest run is the highest
  // id, and this stays readable and indexed. A test with no runs yields NULLs,
  // which the health rollup reads as "never found out" — not as a failure.
  const STEP_SELECT = `
    SELECT s.id, s.journey_id, s.test_id, s.position, s.label, s.required,
           t.name AS test_name, t.enabled AS test_enabled, t.application_id AS test_application_id,
           r.id AS run_id, r.status AS run_status, r.duration_ms AS run_duration_ms,
           r.failure_kind AS run_failure_kind, r.error_message AS run_error_message,
           r.started_at AS run_started_at, r.ended_at AS run_ended_at
      FROM service_test_journey_steps s
      LEFT JOIN service_test_tests t ON t.id = s.test_id
      LEFT JOIN service_test_runs r
             ON r.id = (SELECT MAX(r2.id) FROM service_test_runs r2 WHERE r2.test_id = s.test_id)`;

  function shapeStep(row) {
    if (!row) return null;
    return {
      id: row.id,
      journey_id: row.journey_id,
      test_id: row.test_id,
      position: row.position,
      label: row.label,
      required: row.required === 1 || row.required === true,
      test: row.test_name ? { id: row.test_id, name: row.test_name, enabled: !!row.test_enabled } : null,
      // Null when the test has never run. The health rollup distinguishes that
      // from a failure, which is the whole reason it is not defaulted here.
      run: row.run_id ? {
        id: row.run_id,
        status: row.run_status,
        duration_ms: row.run_duration_ms,
        failure_kind: row.run_failure_kind,
        error_message: row.run_error_message,
        started_at: row.run_started_at,
        ended_at: row.run_ended_at,
      } : null,
    };
  }

  async function findById(id) {
    const [rows] = await pool.query(`${WITH_APP} WHERE j.id = ? LIMIT 1`, [id]);
    return shape(rows[0]);
  }

  async function stepsFor(journeyId) {
    const [rows] = await pool.query(`${STEP_SELECT} WHERE s.journey_id = ? ORDER BY s.position`, [journeyId]);
    return rows.map(shapeStep);
  }

  // Steps for MANY journeys in one query. The list screen shows every journey's
  // health, and doing that per journey is the N+1 that would make the page slow
  // exactly when an estate is big enough to need it.
  async function stepsForMany(journeyIds) {
    const ids = (Array.isArray(journeyIds) ? journeyIds : []).map(intOrNull).filter((n) => n !== null);
    if (!ids.length) return new Map();
    const [rows] = await pool.query(
      `${STEP_SELECT} WHERE s.journey_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.journey_id, s.position`,
      ids
    );
    const out = new Map(ids.map((id) => [id, []]));
    for (const row of rows) {
      const step = shapeStep(row);
      if (!out.has(step.journey_id)) out.set(step.journey_id, []);
      out.get(step.journey_id).push(step);
    }
    return out;
  }

  async function list({ applicationId = null, criticality = null, enabledOnly = false } = {}) {
    const where = [];
    const params = [];
    if (applicationId) { where.push('j.application_id = ?'); params.push(applicationId); }
    if (criticality) { where.push('j.criticality = ?'); params.push(criticality); }
    if (enabledOnly) where.push('j.enabled = 1');
    const [rows] = await pool.query(
      `${WITH_APP} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY FIELD(j.criticality, 'critical', 'high', 'normal', 'low'), a.name, j.name`,
      params
    );
    return rows.map(shape);
  }

  async function create(input) {
    const [res] = await pool.query(
      `INSERT INTO service_test_journeys
         (application_id, name, description, criticality, expected_duration_ms, environment_id, enabled, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.application_id, input.name, input.description ?? null,
        input.criticality || 'normal', intOrNull(input.expected_duration_ms),
        intOrNull(input.environment_id), input.enabled === false ? 0 : 1, intOrNull(input.created_by)]
    );
    return findById(res.insertId);
  }

  async function save(id, input) {
    const sets = [];
    const params = [];
    for (const f of ['name', 'description', 'criticality']) {
      if (input[f] !== undefined) { sets.push(`${f} = ?`); params.push(input[f]); }
    }
    for (const f of ['expected_duration_ms', 'environment_id']) {
      if (input[f] !== undefined) { sets.push(`${f} = ?`); params.push(intOrNull(input[f])); }
    }
    if (input.enabled !== undefined) { sets.push('enabled = ?'); params.push(input.enabled ? 1 : 0); }
    if (input.updated_by !== undefined) { sets.push('updated_by = ?'); params.push(intOrNull(input.updated_by)); }
    if (!sets.length) return findById(id);
    params.push(id);
    const [res] = await pool.query(`UPDATE service_test_journeys SET ${sets.join(', ')} WHERE id = ?`, params);
    if (!res.affectedRows) return null;
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM service_test_journeys WHERE id = ?', [id]);
    return (res.affectedRows || 0) > 0;
  }

  // Replaces a journey's membership with exactly `steps`, in array order.
  //
  // Whole-list, in one transaction, rather than add/remove/reorder calls: the UI
  // is a drag & drop list, so "this is the order now" is the only statement it
  // can make truthfully. Positions are assigned HERE, so no caller has to keep
  // them consistent — the same reasoning as the test designer's step rows.
  async function setSteps(journeyId, steps) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM service_test_journey_steps WHERE journey_id = ?', [journeyId]);
      const list = Array.isArray(steps) ? steps : [];
      for (let i = 0; i < list.length; i += 1) {
        const step = list[i] || {};
        await conn.query(
          `INSERT INTO service_test_journey_steps (journey_id, test_id, position, label, required)
           VALUES (?, ?, ?, ?, ?)`,
          [journeyId, intOrNull(step.test_id), i, step.label ?? null, step.required === false ? 0 : 1]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    return stepsFor(journeyId);
  }

  // Which journeys a given test belongs to. The test screen shows this: a test
  // nobody can see the purpose of is a test nobody dares delete.
  async function journeysForTest(testId) {
    const [rows] = await pool.query(
      `${WITH_APP}
       JOIN service_test_journey_steps s ON s.journey_id = j.id AND s.test_id = ?
       ORDER BY j.name`,
      [testId]
    );
    return rows.map(shape);
  }

  // Every test id used by any journey, so the tests list can mark the ones that
  // are part of a journey without a query per row.
  async function testIdsInJourneys() {
    const [rows] = await pool.query('SELECT DISTINCT test_id FROM service_test_journey_steps');
    return rows.map((r) => r.test_id);
  }

  return {
    findById, list, create, save, remove,
    stepsFor, stepsForMany, setSteps, journeysForTest, testIdsInJourneys,
    now,
  };
}

module.exports = { createJourneysRepository };
