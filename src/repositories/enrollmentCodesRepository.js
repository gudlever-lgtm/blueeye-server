'use strict';

const crypto = require('crypto');

// Data-access for the `enrollment_codes` table (the non-transactional CRUD
// used by the admin/operator endpoints). The atomic "claim a code and enroll
// an agent" operation lives in src/services/enrollmentStore.js.
//
// Status is derived consistently everywhere. "used" (fully consumed) takes
// priority over "expired" so a code that already did its job — an agent enrolled
// with it — reads "used", not "expired", once its short TTL later elapses.
// "expired" is reserved for codes that ran out of time WITHOUT being used up.
// This only changes the label of already-unusable codes: an "active" code is
// still exactly one with uses left AND time left, so the install gate (which
// accepts only status === 'active') is unaffected.
const STATUS_CASE = `
  CASE
    WHEN e.uses_remaining <= 0 THEN 'used'
    WHEN e.expires_at <= NOW() THEN 'expired'
    ELSE 'active'
  END AS status`;

// An enrollment code is a credential (whoever holds one can enroll a machine as
// a trusted agent), so it is never kept in cleartext — migration 076 dropped the
// column. Two columns split the two jobs:
//   code_hash — SHA-256, what every lookup matches on
//   code_enc  — the code encrypted at rest (secretBox), decrypted only for the
//               authenticated "rebuild the install command" endpoint
// `secretBox` is optional so a caller that never needs the plaintext back (and
// the existing tests) can wire the repository without one; without it a code is
// simply not recoverable, which is the safe direction.
function createEnrollmentCodesRepository(db, { secretBox = null } = {}) {
  const { pool } = db;

  const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

  const encryptCode = (code) => {
    if (!secretBox || typeof secretBox.encrypt !== 'function') return null;
    try { return secretBox.encrypt(String(code)); } catch { return null; }
  };

  // The plaintext of a stored row, decrypted from code_enc. Null when there is
  // nothing to decrypt (a row predating migration 076, which dropped the
  // cleartext column) or no secret box is configured — the caller then tells the
  // operator to generate a new code rather than showing a wrong one.
  function decryptCode(row) {
    if (!row || !row.code_enc) return null;
    if (!secretBox || typeof secretBox.decrypt !== 'function') return null;
    try { return secretBox.decrypt(row.code_enc); } catch { return null; }
  }

  // Returns the freshly created row plus the plaintext code IN MEMORY (the caller
  // decides whether to expose it — it is only returned to the operator once).
  // What lands in the database is the hash + the encrypted copy, never the code.
  // `maxUses` defaults to 1 (single-use); higher values create a bulk code.
  async function create({ code, location_id = null, created_by, expiresInMinutes, maxUses = 1 }) {
    const uses = Number.isInteger(maxUses) && maxUses > 0 ? maxUses : 1;
    // `code` is never written: only its hash (for lookups) and, when a secret box
    // is configured, its encrypted form (for the install-command endpoint).
    const [result] = await pool.query(
      `INSERT INTO enrollment_codes (code_hash, code_enc, location_id, created_by, expires_at, max_uses, uses_remaining)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?, ?)`,
      [hashCode(code), encryptCode(code), location_id, created_by, expiresInMinutes, uses, uses]
    );
    const [rows] = await pool.query(
      `SELECT id, location_id, created_by, expires_at, used_at, created_at, max_uses, uses_remaining
       FROM enrollment_codes WHERE id = ?`,
      [result.insertId]
    );
    // The plaintext is handed back in memory — this is the one moment the caller
    // can show it to the operator — but it is not what was persisted.
    return { ...rows[0], code };
  }

  // Lists codes with a derived status — deliberately WITHOUT the plaintext
  // code, so it cannot be retrieved after creation. Each code also carries the
  // agent(s) it enrolled (a bulk code can enroll several) with their live
  // online/offline state, so the UI can show real availability next to the
  // install ticket's status. The token an enrolled agent holds is independent
  // of the code, so this is purely informational.
  async function findAll() {
    const [rows] = await pool.query(`
      SELECT e.id, e.location_id, l.name AS location_name, e.created_by,
             e.expires_at, e.used_at, e.created_at, e.max_uses, e.uses_remaining,${STATUS_CASE}
      FROM enrollment_codes e
      LEFT JOIN locations l ON l.id = e.location_id
      ORDER BY e.id DESC`);
    if (rows.length === 0) return rows;
    const [agentRows] = await pool.query(`
      SELECT id, enrollment_code_id, display_name, hostname, status
      FROM agents
      WHERE enrollment_code_id IS NOT NULL
      ORDER BY id ASC`);
    const byCode = new Map();
    for (const a of agentRows) {
      const list = byCode.get(a.enrollment_code_id) || [];
      list.push({ id: a.id, name: a.display_name || a.hostname, online: a.status === 'online' });
      byCode.set(a.enrollment_code_id, list);
    }
    for (const r of rows) r.agents = byCode.get(r.id) || [];
    return rows;
  }

  // Full row for one code id, INCLUDING the plaintext code — decrypted here for
  // the authenticated command-generation endpoint to rebuild an install command.
  // `code` is null for a row minted before migration 076 (which dropped the
  // cleartext column), or when no secret box is configured; callers must handle
  // that. Such a code is still REDEEMABLE — only re-displaying it is lost.
  async function findById(id) {
    const [rows] = await pool.query(`
      SELECT e.id, e.code_enc, e.location_id, l.name AS location_name, e.created_by,
             e.expires_at, e.used_at, e.created_at, e.max_uses, e.uses_remaining,${STATUS_CASE}
      FROM enrollment_codes e
      LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.id = ?`, [id]);
    const row = rows[0];
    if (!row) return null;
    // `code` is the decrypted plaintext; the stored ciphertext never leaves here.
    const { code_enc: _enc, ...rest } = row;
    return { ...rest, code: decryptCode(row) };
  }

  // Status lookup by plaintext code — hashed here (used by the public install.sh
  // endpoint to reject unknown/expired/exhausted codes before rendering a script).
  async function findByCode(code) {
    // Matched on the hash — including for codes minted before migration 076,
    // whose hash it backfilled.
    const [rows] = await pool.query(`
      SELECT e.id, e.location_id, e.expires_at, e.used_at, e.created_at,
             e.max_uses, e.uses_remaining,${STATUS_CASE}
      FROM enrollment_codes e
      WHERE e.code_hash = ?`, [hashCode(code)]);
    return rows[0] || null;
  }

  async function remove(id) {
    const [result] = await pool.query('DELETE FROM enrollment_codes WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  return { create, findAll, findById, findByCode, remove };
}

module.exports = { createEnrollmentCodesRepository };
