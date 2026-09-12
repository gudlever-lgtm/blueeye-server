'use strict';

const { parseJson, intOrNull } = require('./shape');

// Data-access for `service_ai_analyses` (migration 092).
//
// One row per answer a provider gave, kept with the exact context it was given.
// The context is what makes the row worth having: an AI answer is a suggestion,
// and a suggestion nobody can check is one that gets believed.
function createAiAnalysesRepository({ db, now = () => new Date() }) {
  const { pool } = db;
  const COLS = 'id, incident_id, application_id, kind, answer, model, context, duration_ms, requested_by, created_at';

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      incident_id: row.incident_id,
      application_id: row.application_id,
      kind: row.kind,
      answer: row.answer,
      model: row.model,
      context: parseJson(row.context, null),
      duration_ms: row.duration_ms,
      requested_by: row.requested_by,
      created_at: row.created_at,
      // Never stored as a column, and never absent from a read. Every row in
      // this table is a suggestion; a reader that has to remember that is a
      // reader who will forget.
      is_suggestion: true,
      source: 'ai',
    };
  }

  const cut = (v, max) => (v === null || v === undefined ? null : String(v).slice(0, max));

  async function record(input) {
    const row = (input && typeof input === 'object') ? input : {};
    const [res] = await pool.query(
      `INSERT INTO service_ai_analyses
         (incident_id, application_id, kind, answer, model, context, duration_ms, requested_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        intOrNull(row.incident_id),
        intOrNull(row.application_id),
        cut(row.kind || 'unknown', 64),
        // The column is NOT NULL: an empty answer is not an analysis, and the
        // service refuses one before it gets here. Defended anyway, because a
        // NOT NULL violation would lose an answer that did arrive.
        String(row.answer === null || row.answer === undefined ? '' : row.answer),
        cut(row.model, 120),
        row.context ? JSON.stringify(row.context) : null,
        intOrNull(row.duration_ms),
        intOrNull(row.requested_by),
        row.created_at instanceof Date ? row.created_at : now(),
      ]
    );
    return findById(res.insertId);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_ai_analyses WHERE id = ?`, [intOrNull(id)]);
    return shape(rows[0]);
  }

  // The analyses of one incident, newest first — what the incident screen reads
  // so it can show an existing answer rather than asking for another.
  async function forIncident(incidentId, { limit = 10 } = {}) {
    const capped = Math.min(50, Math.max(1, Number(limit) || 10));
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_ai_analyses WHERE incident_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ${capped}`,
      [intOrNull(incidentId)]
    );
    return rows.map(shape);
  }

  // Retention. Contexts are the largest thing in this table and an analysis of a
  // resolved incident stops being interesting long before it stops being stored.
  async function purgeOlderThan(days) {
    const window = Number(days) > 0 ? Number(days) : 180;
    const cutoff = new Date(now().getTime() - window * 86400000);
    const [res] = await pool.query('DELETE FROM service_ai_analyses WHERE created_at < ?', [cutoff]);
    return res.affectedRows;
  }

  return { record, findById, forIncident, purgeOlderThan, shape };
}

module.exports = { createAiAnalysesRepository };
