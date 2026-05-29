'use strict';

// Data-access for the `enrollment_codes` table (the non-transactional CRUD
// used by the admin/operator endpoints). The atomic "claim a code and enroll
// an agent" operation lives in src/services/enrollmentStore.js.
function createEnrollmentCodesRepository(db) {
  const { pool } = db;

  // Returns the freshly created row, including the plaintext code (the caller
  // decides whether to expose it — it is only returned to the operator once).
  async function create({ code, location_id = null, created_by, expiresInMinutes }) {
    const [result] = await pool.query(
      `INSERT INTO enrollment_codes (code, location_id, created_by, expires_at)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [code, location_id, created_by, expiresInMinutes]
    );
    const [rows] = await pool.query(
      `SELECT id, code, location_id, created_by, expires_at, used_at, created_at
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
             e.expires_at, e.used_at, e.created_at,
             CASE
               WHEN e.used_at IS NOT NULL THEN 'used'
               WHEN e.expires_at <= NOW() THEN 'expired'
               ELSE 'active'
             END AS status
      FROM enrollment_codes e
      LEFT JOIN locations l ON l.id = e.location_id
      ORDER BY e.id DESC`);
    return rows;
  }

  async function remove(id) {
    const [result] = await pool.query('DELETE FROM enrollment_codes WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  return { create, findAll, remove };
}

module.exports = { createEnrollmentCodesRepository };
