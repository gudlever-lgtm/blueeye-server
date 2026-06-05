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

  // The most recent result per agent (for the fleet overview throughput signal).
  async function latestPerAgent() {
    const [rows] = await pool.query(
      `SELECT s.agent_id, s.ts, s.ok, s.down_mbps, s.up_mbps
       FROM speedtest_results s
       JOIN (SELECT agent_id, MAX(ts) AS mts FROM speedtest_results GROUP BY agent_id) m
         ON m.agent_id = s.agent_id AND m.mts = s.ts`
    );
    return rows;
  }

  return { create, findByAgent, latestPerAgent };
}

module.exports = { createSpeedtestResultsRepository };
