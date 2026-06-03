'use strict';

// Data-access for the `enrollment_codes` table (the non-transactional CRUD
// used by the admin/operator endpoints). The atomic "claim a code and enroll
// an agent" operation lives in src/services/enrollmentStore.js.
//
// Status is derived consistently everywhere: expired (past TTL) takes priority,
// then used (no uses left), otherwise active.
const STATUS_CASE = `
  CASE
    WHEN e.expires_at <= NOW() THEN 'expired'
    WHEN e.uses_remaining <= 0 THEN 'used'
    ELSE 'active'
  END AS status`;

function createEnrollmentCodesRepository(db) {
  const { pool } = db;

  // Returns the freshly created row, including the plaintext code (the caller
  // decides whether to expose it — it is only returned to the operator once).
  // `maxUses` defaults to 1 (single-use); higher values create a bulk code.
  async function create({ code, location_id = null, created_by, expiresInMinutes, maxUses = 1 }) {
    const uses = Number.isInteger(maxUses) && maxUses > 0 ? maxUses : 1;
    const [result] = await pool.query(
      `INSERT INTO enrollment_codes (code, location_id, created_by, expires_at, max_uses, uses_remaining)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?, ?)`,
      [code, location_id, created_by, expiresInMinutes, uses, uses]
    );
    const [rows] = await pool.query(
      `SELECT id, code, location_id, created_by, expires_at, used_at, created_at, max_uses, uses_remaining
       FROM enrollment_codes WHERE id = ?`,
      [result.insertId]
    );
    return rows[0];
  }

  // Lists codes with a derived status — deliberately WITHOUT the plaintext
  // code, so it cannot be retrieved after creation.
  async function findAll() {
    const [rows] = await pool.query(`
      SELECT e.id, e.location_id, l.name AS location_name, e.created_by,
             e.expires_at, e.used_at, e.created_at, e.max_uses, e.uses_remaining,${STATUS_CASE}
      FROM enrollment_codes e
      LEFT JOIN locations l ON l.id = e.location_id
      ORDER BY e.id DESC`);
    return rows;
  }

  // Full row for one code id, INCLUDING the plaintext code (used by the
  // authenticated command-generation endpoint to rebuild an install command).
  async function findById(id) {
    const [rows] = await pool.query(`
      SELECT e.id, e.code, e.location_id, l.name AS location_name, e.created_by,
             e.expires_at, e.used_at, e.created_at, e.max_uses, e.uses_remaining,${STATUS_CASE}
      FROM enrollment_codes e
      LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.id = ?`, [id]);
    return rows[0] || null;
  }

  // Status lookup by plaintext code (used by the public install.sh endpoint to
  // reject unknown/expired/exhausted codes before rendering a script).
  async function findByCode(code) {
    const [rows] = await pool.query(`
      SELECT e.id, e.location_id, e.expires_at, e.used_at, e.created_at,
             e.max_uses, e.uses_remaining,${STATUS_CASE}
      FROM enrollment_codes e
      WHERE e.code = ?`, [code]);
    return rows[0] || null;
  }

  async function remove(id) {
    const [result] = await pool.query('DELETE FROM enrollment_codes WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  return { create, findAll, findById, findByCode, remove };
}

module.exports = { createEnrollmentCodesRepository };
