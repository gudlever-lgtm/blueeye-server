'use strict';

// Data-access for `speedtest_results` — active throughput measurements the agent
// reports after downloading/uploading a sized blob to/from this server.
function createSpeedtestResultsRepository(db) {
  const { pool } = db;

  // Inserts one result for an agent. Returns the new row id.
  async function create(agentId, r) {
    const [result] = await pool.query(
      `INSERT INTO speedtest_results
         (agent_id, ts, ok, down_mbps, up_mbps, down_bytes, up_bytes, down_ms, up_ms, target, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId,
        r.ts || new Date(),
        r.ok ? 1 : 0,
        r.downMbps, r.upMbps,
        r.downBytes, r.upBytes,
        r.downMs, r.upMs,
        r.target || null, r.detail || null,
      ]
    );
    return result.insertId;
  }

  // Recent results for an agent, newest first (default 50, max 500).
  async function findByAgent(agentId, limit = 50) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const [rows] = await pool.query(
      `SELECT id, agent_id, ts, ok, down_mbps, up_mbps, down_bytes, up_bytes, down_ms, up_ms, target, detail, created_at
       FROM speedtest_results WHERE agent_id = ? ORDER BY ts DESC LIMIT ?`,
      [agentId, lim]
    );
    return rows;
  }

  return { create, findByAgent };
}

module.exports = { createSpeedtestResultsRepository };
