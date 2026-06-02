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

  // Results for one agent, optionally filtered by a created_at time range.
  // range = { from, to, limit } (from/to are Date or null). Newest first.
  async function findByAgentId(agentId, range = {}) {
    const where = ['agent_id = ?'];
    const params = [agentId];
    if (range.from) { where.push('created_at >= ?'); params.push(range.from); }
    if (range.to) { where.push('created_at <= ?'); params.push(range.to); }
    const limit = Number.isInteger(range.limit) ? range.limit : 1000;
    params.push(limit);
    const [rows] = await pool.query(
      `SELECT id, agent_id, payload, created_at FROM results
       WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      params
    );
    return rows.map((row) => ({ ...row, payload: parsePayload(row.payload) }));
  }

  // All results for the agents in a location within a time range (oldest first,
  // so the caller can build a chronological series). Joins the agent so each row
  // knows which agent it belongs to.
  async function rangeByLocation(locationId, range = {}) {
    const where = ['a.location_id = ?'];
    const params = [locationId];
    if (range.from) { where.push('r.created_at >= ?'); params.push(range.from); }
    if (range.to) { where.push('r.created_at <= ?'); params.push(range.to); }
    const limit = Number.isInteger(range.limit) ? range.limit : 5000;
    params.push(limit);
    const [rows] = await pool.query(
      `SELECT r.id, r.agent_id, a.hostname, a.display_name, r.payload, r.created_at
       FROM results r
       JOIN agents a ON a.id = r.agent_id
       WHERE ${where.join(' AND ')}
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT ?`,
      params
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

  // The LATEST result per agent across the WHOLE fleet (agents with no results
  // yet are omitted) — one query, for the fleet-health rollup which folds each
  // agent's interface health into its verdict.
  async function latestPerAgent() {
    const [rows] = await pool.query(
      `SELECT t.agent_id, t.payload, t.created_at
       FROM results t
       JOIN (SELECT agent_id, MAX(id) AS max_id FROM results GROUP BY agent_id) m
         ON m.max_id = t.id`
    );
    return rows.map((row) => ({ ...row, payload: parsePayload(row.payload) }));
  }

  return { createMany, findByAgentId, latestByLocation, latestPerAgent, rangeByLocation };
}

module.exports = { createResultsRepository };
