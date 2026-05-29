'use strict';

// Atomically claims an enrollment code and enrolls a new agent. The whole
// operation runs in a single transaction with the code row locked FOR UPDATE,
// so a code can never be redeemed twice (even under concurrent requests).
//
// The caller generates the opaque token and passes only its hash here — the
// plaintext token never reaches the database layer.
function createEnrollmentStore(db) {
  const { pool } = db;

  // Returns one of:
  //   { status: 'invalid' }              — no such code
  //   { status: 'used' }                 — already redeemed
  //   { status: 'expired' }              — past its expiry
  //   { status: 'ok', agentId: <number> } — enrolled
  // Throws only on unexpected database errors.
  async function claimAndEnroll({ code, hostname, platform, arch, tokenHash }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Expiry is evaluated in the database to avoid app/DB timezone skew.
      const [rows] = await conn.query(
        `SELECT id, location_id, used_at, (expires_at <= NOW()) AS is_expired
         FROM enrollment_codes WHERE code = ? FOR UPDATE`,
        [code]
      );
      const row = rows[0];

      if (!row) {
        await conn.rollback();
        return { status: 'invalid' };
      }
      if (row.used_at !== null) {
        await conn.rollback();
        return { status: 'used' };
      }
      if (row.is_expired) {
        await conn.rollback();
        return { status: 'expired' };
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
      await conn.query(
        'UPDATE enrollment_codes SET used_at = NOW() WHERE id = ?',
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

module.exports = { createEnrollmentStore };
