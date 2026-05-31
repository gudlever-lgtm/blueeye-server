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

  // Returns the LATEST result per agent for every agent in the given location
  // (agents with no results yet are included with payload = null), so the
  // caller can correlate current traffic across a location.
  async function latestByLocation(locationId) {
    const [rows] = await pool.query(
      `SELECT a.id AS agent_id, a.hostname, a.display_name, a.status,
              r.id AS result_id, r.payload, r.created_at
       FROM agents a
       LEFT JOIN (
         SELECT t.agent_id, t.id, t.payload, t.created_at
         FROM results t
         JOIN (SELECT agent_id, MAX(id) AS max_id FROM results GROUP BY agent_id) m
           ON m.max_id = t.id
       ) r ON r.agent_id = a.id
       WHERE a.location_id = ?
       ORDER BY a.id`,
      [locationId]
    );
    return rows.map((row) => ({ ...row, payload: parsePayload(row.payload) }));
  }

  return { createMany, findByAgentId, latestByLocation };
}

module.exports = { createResultsRepository };
