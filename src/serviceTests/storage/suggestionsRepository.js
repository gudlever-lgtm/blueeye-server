'use strict';

const { parseJson, intOrNull } = require('./shape');

// Data-access for `service_test_suggestions` (migration 078) — the rule-based
// proposals a finished discovery produces (spec §12; no AI anywhere near this).
// Accepting one records which test it created, so the Suggested-tests screen can
// show "already accepted" instead of offering a duplicate.
function createSuggestionsRepository({ db }) {
  const { pool } = db;
  const COLS = `id,tenant_id,discovery_id,application_id,kind,name,description,confidence,reason,
    proposed_steps,proposed_journey,status,created_test_id,created_journey_id,created_at,updated_at`;

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      discovery_id: row.discovery_id,
      application_id: row.application_id,
      name: row.name,
      description: row.description,
      kind: row.kind || 'test',
      confidence: row.confidence,
      reason: row.reason,
      proposed_steps: parseJson(row.proposed_steps, []),
      // Null for a test suggestion. For a journey it is
      // { criticality, expected_duration_ms, steps: [{ suggestion_name, required }] }
      // — members named rather than referenced, because the tests do not exist
      // until the journey is accepted.
      proposed_journey: parseJson(row.proposed_journey, null),
      created_journey_id: row.created_journey_id ?? null,
      status: row.status,
      created_test_id: row.created_test_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_suggestions WHERE id = ?`, [id]);
    return shape(rows[0]);
  }

  async function list({ discoveryId = null, applicationId = null, status = null, kind = null } = {}) {
    const where = [];
    const params = [];
    if (discoveryId !== null) { where.push('discovery_id = ?'); params.push(discoveryId); }
    if (kind !== null) { where.push('kind = ?'); params.push(kind); }
    if (applicationId !== null) { where.push('application_id = ?'); params.push(applicationId); }
    if (status !== null) { where.push('status = ?'); params.push(status); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_suggestions ${clause} ORDER BY FIELD(kind, 'journey', 'test'), id`, params);
    return rows.map(shape);
  }

  async function createMany(discoveryId, applicationId, suggestions) {
    const ids = [];
    for (const s of suggestions || []) {
      // eslint-disable-next-line no-await-in-loop
      const isJourney = s.kind === 'journey';
      const [res] = await pool.query(
        `INSERT INTO service_test_suggestions
          (discovery_id, application_id, kind, name, description, confidence, reason, proposed_steps, proposed_journey)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [discoveryId, applicationId, isJourney ? 'journey' : 'test', s.name, s.description ?? null,
          s.confidence || 'medium', s.reason ?? null,
          JSON.stringify(s.proposed_steps || []),
          isJourney ? JSON.stringify(s.proposed_journey || null) : null]
      );
      ids.push(res.insertId);
    }
    return ids;
  }

  // `accepted` means the same thing for both kinds: this suggestion produced a
  // real thing, and here is which. A test suggestion sets created_test_id, a
  // journey suggestion sets created_journey_id.
  async function markAccepted(id, testId, journeyId = null) {
    const [res] = await pool.query(
      `UPDATE service_test_suggestions
         SET status = 'accepted', created_test_id = ?, created_journey_id = ?
       WHERE id = ? AND status = 'proposed'`,
      [intOrNull(testId), intOrNull(journeyId), id]
    );
    if (!res.affectedRows) return null;
    return findById(id);
  }

  async function markDismissed(id) {
    const [res] = await pool.query(
      "UPDATE service_test_suggestions SET status = 'dismissed' WHERE id = ? AND status = 'proposed'",
      [id]
    );
    if (!res.affectedRows) return null;
    return findById(id);
  }

  return { findById, list, createMany, markAccepted, markDismissed };
}

module.exports = { createSuggestionsRepository };
