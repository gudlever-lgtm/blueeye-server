'use strict';

// Decides the outcome of a claim from a locked code row. Pure + side-effect
// free so the N-uses / expiry / exhaustion logic is unit-testable without a DB.
//   row: { used_at, is_expired, uses_remaining } | undefined
// Returns { status: 'invalid'|'expired'|'used'|'ok', remainingAfter? }.
function decideOutcome(row) {
  if (!row) return { status: 'invalid' };
  if (row.is_expired) return { status: 'expired' };
  // Pre-migration rows may lack uses_remaining: fall back to used_at semantics.
  const remaining = row.uses_remaining == null
    ? (row.used_at == null ? 1 : 0)
    : Number(row.uses_remaining);
  if (!(remaining > 0)) return { status: 'used' };
  return { status: 'ok', remainingAfter: remaining - 1 };
}

// Atomically claims an enrollment code and enrolls a new agent. The whole
// operation runs in a single transaction with the code row locked FOR UPDATE,
// so a code can never be over-redeemed (even under concurrent requests). Bulk
// codes (max_uses > 1) decrement uses_remaining; the code is marked used_at
// only once fully consumed.
//
// The caller generates the opaque token and passes only its hash here — the
// plaintext token never reaches the database layer.
function createEnrollmentStore(db) {
  const { pool } = db;

  // Returns one of:
  //   { status: 'invalid' }               — no such code
  //   { status: 'used' }                  — no uses left (single- or multi-use)
  //   { status: 'expired' }               — past its expiry
  //   { status: 'ok', agentId: <number> } — enrolled
  // Throws only on unexpected database errors.
  async function claimAndEnroll({ code, hostname, platform, arch, tokenHash }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Expiry is evaluated in the database to avoid app/DB timezone skew.
      const [rows] = await conn.query(
        `SELECT id, location_id, used_at, uses_remaining, (expires_at <= NOW()) AS is_expired
         FROM enrollment_codes WHERE code = ? FOR UPDATE`,
        [code]
      );
      const row = rows[0];
      const decision = decideOutcome(row);
      if (decision.status !== 'ok') {
        await conn.rollback();
        return { status: decision.status };
      }

      const [agentResult] = await conn.query(
        `INSERT INTO agents (hostname, platform, arch, location_id)
         VALUES (?, ?, ?, ?)`,
        [hostname, platform, arch, row.location_id]
      );
      const agentId = agentResult.insertId;

      await conn.query(
        'INSERT INTO agent_tokens (agent_id, token_hash) VALUES (?, ?)',
        [agentId, tokenHash]
      );
      // Decrement the remaining uses; stamp used_at once the code is exhausted.
      await conn.query(
        `UPDATE enrollment_codes
         SET uses_remaining = GREATEST(uses_remaining - 1, 0),
             used_at = CASE WHEN uses_remaining - 1 <= 0 THEN NOW() ELSE used_at END
         WHERE id = ?`,
        [row.id]
      );

      await conn.commit();
      return { status: 'ok', agentId };
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* the original error is what matters */
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  return { claimAndEnroll };
}

module.exports = { createEnrollmentStore, decideOutcome };
