'use strict';

function parsePayload(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

// Data-access for the `results` table.
function createResultsRepository(db) {
  const { pool } = db;

  // Bulk-inserts one row per payload. Returns the number of rows inserted.
  async function createMany(agentId, payloads) {
    if (!Array.isArray(payloads) || payloads.length === 0) return 0;
    const values = payloads.map((payload) => [agentId, JSON.stringify(payload)]);
    const [result] = await pool.query(
      'INSERT INTO results (agent_id, payload) VALUES ?',
      [values]
    );
    return result.affectedRows;
  }

  async function findByAgentId(agentId) {
    const [rows] = await pool.query(
      'SELECT id, agent_id, payload, created_at FROM results WHERE agent_id = ? ORDER BY id DESC',
      [agentId]
    );
    return rows.map((row) => ({ ...row, payload: parsePayload(row.payload) }));
  }

  return { createMany, findByAgentId };
}

module.exports = { createResultsRepository };
