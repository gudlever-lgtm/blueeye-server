'use strict';

// Data-access for `diagnose_sessions` + `diagnose_session_tests` (migration
// 097). Pure data access: no policy, no plan-building, no verdicts.
//
// The one thing worth reading twice is findResultsFor(). probe_results has no
// run id — the agent reports a measurement, not a reply to a request — so a
// session finds its own results by (agent, type, target) within the window that
// opened when the test was dispatched. Two safeguards make that honest rather
// than approximate: the window is bounded at both ends, and once a row is
// matched its id is stored on the test, so the link stops being a search and
// becomes a fact.

const SESSION_COLS = `id, description, locale, matched_by, agent_id, peer_agent_id, target,
  entities, plan, evaluation, status, created_by, created_at, updated_at`;
const TEST_COLS = `id, session_id, playbook_id, agent_id, direction, probe_type, target,
  params, status, dispatched_at, probe_result_id, detail, created_at`;

// How long after dispatch a result may still be this test's. Ten minutes is
// comfortably longer than the slowest probe (a per-hop path_mtu with a
// traceroute in front of it) and far shorter than the gap between two
// investigations of the same target.
const RESULT_WINDOW_MS = 10 * 60 * 1000;

const toIso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString()));

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    description: row.description,
    locale: row.locale,
    matchedBy: row.matched_by,
    agentId: row.agent_id == null ? null : Number(row.agent_id),
    peerAgentId: row.peer_agent_id == null ? null : Number(row.peer_agent_id),
    target: row.target ?? null,
    entities: parseJson(row.entities),
    plan: parseJson(row.plan),
    evaluation: parseJson(row.evaluation),
    status: row.status,
    createdBy: row.created_by ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapTest(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sessionId: Number(row.session_id),
    playbookId: row.playbook_id,
    agentId: row.agent_id == null ? null : Number(row.agent_id),
    direction: row.direction,
    probeType: row.probe_type,
    target: row.target,
    params: parseJson(row.params),
    status: row.status,
    dispatchedAt: toIso(row.dispatched_at),
    probeResultId: row.probe_result_id == null ? null : Number(row.probe_result_id),
    detail: row.detail ?? null,
    createdAt: toIso(row.created_at),
  };
}

function createDiagnoseSessionsRepository(db) {
  const { pool } = db;

  async function create({
    description, locale = 'en', matchedBy = 'keywords', agentId = null, peerAgentId = null,
    target = null, entities = null, plan, createdBy = null, tests = [],
  }) {
    const [res] = await pool.query(
      `INSERT INTO diagnose_sessions
         (description, locale, matched_by, agent_id, peer_agent_id, target, entities, plan, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(description).slice(0, 1000), locale, matchedBy, agentId, peerAgentId,
        target == null ? null : String(target).slice(0, 255),
        entities ? JSON.stringify(entities) : null,
        JSON.stringify(plan), createdBy,
      ]
    );
    const id = Number(res.insertId);
    if (tests.length) {
      await pool.query(
        `INSERT INTO diagnose_session_tests
           (session_id, playbook_id, agent_id, direction, probe_type, target, params) VALUES ?`,
        [tests.map((t) => [
          id, t.playbookId, t.agentId ?? null, t.direction || 'forward',
          t.probeType, String(t.target).slice(0, 255),
          t.params ? JSON.stringify(t.params) : null,
        ])]
      );
    }
    return id;
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${SESSION_COLS} FROM diagnose_sessions WHERE id = ?`, [id]);
    return mapSession(rows[0]) ?? null;
  }

  async function list({ limit = 50, offset = 0 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
    const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const [rows] = await pool.query(
      `SELECT ${SESSION_COLS} FROM diagnose_sessions ORDER BY id DESC LIMIT ? OFFSET ?`,
      [lim, off]
    );
    return rows.map(mapSession);
  }

  async function listTests(sessionId) {
    const [rows] = await pool.query(
      `SELECT ${TEST_COLS} FROM diagnose_session_tests WHERE session_id = ? ORDER BY id ASC`,
      [sessionId]
    );
    return rows.map(mapTest);
  }

  // Marks a test as sent to an agent and opens its correlation window.
  async function markDispatched(testId, { at = new Date(), agentId = null } = {}) {
    await pool.query(
      `UPDATE diagnose_session_tests SET status = 'dispatched', dispatched_at = ?, agent_id = COALESCE(?, agent_id), detail = NULL WHERE id = ?`,
      [at, agentId, testId]
    );
  }

  // Records that a test could not be sent at all — the agent is offline, the
  // probe type is one it does not have. A failure with a reason is a result; a
  // test stuck on 'pending' for ever is a bug report.
  async function markFailed(testId, detail) {
    await pool.query(
      `UPDATE diagnose_session_tests SET status = 'failed', detail = ? WHERE id = ?`,
      [detail == null ? null : String(detail).slice(0, 255), testId]
    );
  }

  async function attachResult(testId, probeResultId) {
    await pool.query(
      `UPDATE diagnose_session_tests SET status = 'complete', probe_result_id = ? WHERE id = ?`,
      [probeResultId, testId]
    );
  }

  async function setStatus(sessionId, status) {
    await pool.query('UPDATE diagnose_sessions SET status = ? WHERE id = ?', [status, sessionId]);
  }

  async function saveEvaluation(sessionId, evaluation) {
    await pool.query(
      `UPDATE diagnose_sessions SET evaluation = ?, status = 'evaluated' WHERE id = ?`,
      [JSON.stringify(evaluation), sessionId]
    );
  }

  // The result of ONE dispatched test, or null when nothing has come back yet.
  // Bounded at both ends of the window (see the module note) and taking the
  // OLDEST matching row rather than the newest: the first answer after dispatch
  // is the answer to this dispatch, and a later one belongs to whatever ran next.
  async function findResultFor(test, { windowMs = RESULT_WINDOW_MS } = {}) {
    if (!test || !test.dispatchedAt || test.agentId == null) return null;
    const from = new Date(test.dispatchedAt);
    const to = new Date(from.getTime() + windowMs);
    const [rows] = await pool.query(
      `SELECT * FROM probe_results
       WHERE agent_id = ? AND type = ? AND target = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC, id ASC LIMIT 1`,
      [test.agentId, test.probeType, test.target, from, to]
    );
    return rows[0] ?? null;
  }

  return {
    create, findById, list, listTests,
    markDispatched, markFailed, attachResult, setStatus, saveEvaluation, findResultFor,
    RESULT_WINDOW_MS,
  };
}

module.exports = { createDiagnoseSessionsRepository, mapSession, mapTest, RESULT_WINDOW_MS };
