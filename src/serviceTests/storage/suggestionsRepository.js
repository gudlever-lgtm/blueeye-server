'use strict';

const { parseJson, intOrNull } = require('./shape');

// Data-access for `service_test_suggestions` (migration 078) — the rule-based
// proposals a finished discovery produces (spec §12; no AI anywhere near this).
// Accepting one records which test it created, so the Suggested-tests screen can
// show "already accepted" instead of offering a duplicate.
function createSuggestionsRepository({ db }) {
  const { pool } = db;
  const COLS = `id,tenant_id,discovery_id,application_id,name,description,confidence,reason,
    proposed_steps,status,created_test_id,created_at,updated_at`;

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      discovery_id: row.discovery_id,
      application_id: row.application_id,
      name: row.name,
      description: row.description,
      confidence: row.confidence,
      reason: row.reason,
      proposed_steps: parseJson(row.proposed_steps, []),
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

  async function list({ discoveryId = null, applicationId = null, status = null } = {}) {
    const where = [];
    const params = [];
    if (discoveryId !== null) { where.push('discovery_id = ?'); params.push(discoveryId); }
    if (applicationId !== null) { where.push('application_id = ?'); params.push(applicationId); }
    if (status !== null) { where.push('status = ?'); params.push(status); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_suggestions ${clause} ORDER BY id`, params);
    return rows.map(shape);
  }

  async function createMany(discoveryId, applicationId, suggestions) {
    const ids = [];
    for (const s of suggestions || []) {
      // eslint-disable-next-line no-await-in-loop
      const [res] = await pool.query(
        `INSERT INTO service_test_suggestions
          (discovery_id, application_id, name, description, confidence, reason, proposed_steps)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [discoveryId, applicationId, s.name, s.description ?? null, s.confidence || 'medium',
          s.reason ?? null, JSON.stringify(s.proposed_steps || [])]
      );
      ids.push(res.insertId);
    }
    return ids;
  }

  async function markAccepted(id, testId) {
    const [res] = await pool.query(
      "UPDATE service_test_suggestions SET status = 'accepted', created_test_id = ? WHERE id = ? AND status = 'proposed'",
      [intOrNull(testId), id]
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
