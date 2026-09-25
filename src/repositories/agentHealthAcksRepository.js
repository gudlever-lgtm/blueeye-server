'use strict';

// Data-access for `agent_health_acks` (migration 138) — the shared "somebody
// has this" marker on an agent's Fleet verdict.
//
// One row per agent: acknowledging again REPLACES the previous row rather than
// appending, because the question the screen asks is "is this one cleared right
// now", not "how often has it been cleared". Who cleared what and when is in the
// audit trail.
//
// The signature is the verdict the acknowledgement covers (healthSignature in
// src/health/healthAck.js); matching it against the live verdict is the route's
// job, so this module stores and returns rows and decides nothing.

const BASE_COLUMNS = `agent_id, signature, status, note, acked_by, acked_email, acked_at`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    agentId: Number(row.agent_id),
    signature: row.signature,
    status: row.status,
    note: row.note ?? null,
    ackedBy: row.acked_by == null ? null : Number(row.acked_by),
    ackedEmail: row.acked_email ?? null,
    ackedAt: toIso(row.acked_at),
  };
}

function createAgentHealthAcksRepository(db) {
  const { pool } = db;

  // Every live acknowledgement, keyed by agent id — one query for the whole
  // fleet rollup rather than one per agent.
  async function findAll() {
    const [rows] = await pool.query(`SELECT ${BASE_COLUMNS} FROM agent_health_acks`);
    const out = {};
    for (const row of rows) out[Number(row.agent_id)] = mapRow(row);
    return out;
  }

  async function findByAgent(agentId) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM agent_health_acks WHERE agent_id = ?`,
      [agentId]
    );
    return mapRow(rows[0]);
  }

  async function set({ agentId, signature, status, note = null, ackedBy = null, ackedEmail = null }) {
    await pool.query(
      `INSERT INTO agent_health_acks
         (agent_id, signature, status, note, acked_by, acked_email, acked_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE
         signature = VALUES(signature), status = VALUES(status), note = VALUES(note),
         acked_by = VALUES(acked_by), acked_email = VALUES(acked_email), acked_at = VALUES(acked_at)`,
      [agentId, signature, status, note, ackedBy, ackedEmail]
    );
    return findByAgent(agentId);
  }

  // Undoing an acknowledgement, and the cleanup a changed verdict deserves.
  // Returns whether a row was actually removed, so the route can answer 404 for
  // an agent that was never acknowledged instead of a silent 204.
  async function clear(agentId) {
    const [res] = await pool.query('DELETE FROM agent_health_acks WHERE agent_id = ?', [agentId]);
    return Number(res.affectedRows) > 0;
  }

  return { findAll, findByAgent, set, clear };
}

module.exports = { createAgentHealthAcksRepository };
