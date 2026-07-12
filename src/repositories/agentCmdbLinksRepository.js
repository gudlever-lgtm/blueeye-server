'use strict';

// Data-access for `agent_cmdb_links` — one row per agent, linking it to a single
// CMDB asset. The DB cascades the delete when the agent is removed. Kept minimal:
// get / set (upsert) / remove, all keyed by agent_id.
function createAgentCmdbLinksRepository(db) {
  const { pool } = db;

  async function get(agentId) {
    const [rows] = await pool.query(
      'SELECT agent_id, cmdb_asset_id, cmdb_asset_name, linked_at, linked_by FROM agent_cmdb_links WHERE agent_id = ?',
      [agentId]
    );
    return rows[0] ?? null;
  }

  // Upsert the single link for an agent (a re-link overwrites the previous asset).
  async function set(agentId, { cmdbAssetId, cmdbAssetName, linkedBy = null }) {
    await pool.query(
      `INSERT INTO agent_cmdb_links (agent_id, cmdb_asset_id, cmdb_asset_name, linked_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE cmdb_asset_id = VALUES(cmdb_asset_id),
                               cmdb_asset_name = VALUES(cmdb_asset_name),
                               linked_by = VALUES(linked_by),
                               linked_at = CURRENT_TIMESTAMP`,
      [agentId, cmdbAssetId, cmdbAssetName, linkedBy]
    );
    return get(agentId);
  }

  async function remove(agentId) {
    const [result] = await pool.query('DELETE FROM agent_cmdb_links WHERE agent_id = ?', [agentId]);
    return result.affectedRows > 0;
  }

  return { get, set, remove };
}

module.exports = { createAgentCmdbLinksRepository };
