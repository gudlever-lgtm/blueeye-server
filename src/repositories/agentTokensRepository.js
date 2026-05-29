'use strict';

// Data-access for the `agent_tokens` table (lookups by hash for agent auth).
function createAgentTokensRepository(db) {
  const { pool } = db;

  // Returns { id, agent_id } for a live (non-revoked) token, or null.
  async function findActiveByHash(tokenHash) {
    const [rows] = await pool.query(
      'SELECT id, agent_id FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL',
      [tokenHash]
    );
    return rows[0] ?? null;
  }

  async function touchLastUsed(id) {
    await pool.query('UPDATE agent_tokens SET last_used_at = NOW() WHERE id = ?', [id]);
  }

  return { findActiveByHash, touchLastUsed };
}

module.exports = { createAgentTokensRepository };
