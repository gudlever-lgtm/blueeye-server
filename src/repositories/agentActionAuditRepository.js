'use strict';

// Data-access for `agent_action_audit` — the trail of server-initiated agent
// actions (upgrade/delete). record() inserts the 'requested' row and returns its
// id; complete() flips that row to a terminal 'completed'/'failed' state when the
// agent reports back. Reads are newest-first and filterable per agent / per
// actor. Never writes secrets.
function createAgentActionAuditRepository(db) {
  const { pool } = db;

  // Inserts a 'requested' action and returns its new id.
  async function record({
    agentId = null, agentHostname = null, locationId = null,
    actorUserId = null, actorEmail = null, actorRole = null,
    action, targetVersion = null,
  }) {
    const [res] = await pool.query(
      `INSERT INTO agent_action_audit
         (agent_id, agent_hostname, location_id, actor_user_id, actor_email, actor_role, action, target_version, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested')`,
      [agentId, agentHostname, locationId, actorUserId, actorEmail, actorRole, action, targetVersion]
    );
    return res.insertId;
  }

  // Flips a still-'requested' row to a terminal state when the agent reports
  // back. Returns true if a row was updated (false for an unknown/already-final
  // id). result_detail is truncated to the column width.
  async function complete(id, { state, resultDetail = null }) {
    const detail = resultDetail == null ? null : String(resultDetail).slice(0, 512);
    const [res] = await pool.query(
      `UPDATE agent_action_audit
          SET state = ?, result_detail = ?, completed_at = NOW()
        WHERE id = ? AND state = 'requested'`,
      [state, detail, id]
    );
    return res.affectedRows > 0;
  }

  async function findByAgent(agentId, { limit = 100 } = {}) {
    const [rows] = await pool.query(
      'SELECT * FROM agent_action_audit WHERE agent_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?',
      [agentId, limit]
    );
    return rows;
  }

  async function findByActor(actorUserId, { limit = 100 } = {}) {
    const [rows] = await pool.query(
      'SELECT * FROM agent_action_audit WHERE actor_user_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?',
      [actorUserId, limit]
    );
    return rows;
  }

  async function findAll({ limit = 100 } = {}) {
    const [rows] = await pool.query(
      'SELECT * FROM agent_action_audit ORDER BY requested_at DESC, id DESC LIMIT ?',
      [limit]
    );
    return rows;
  }

  return { record, complete, findByAgent, findByActor, findAll };
}

module.exports = { createAgentActionAuditRepository };
