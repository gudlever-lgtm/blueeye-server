'use strict';

// Data-access for `oidc_role_map` — maps an OIDC claim value (a group/role name
// from the id-token `groups` claim) to a BlueEye role. On login the user's claim
// values are looked up and the HIGHEST matching role wins (admin > operator >
// viewer). NO match means access is DENIED — there is deliberately no default role.
function createOidcRoleMapRepository(db) {
  const { pool } = db;

  async function findAll() {
    const [rows] = await pool.query('SELECT * FROM oidc_role_map ORDER BY id');
    return rows;
  }

  async function findById(id) {
    const [rows] = await pool.query('SELECT * FROM oidc_role_map WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  async function findByClaim(claimValue) {
    const [rows] = await pool.query('SELECT * FROM oidc_role_map WHERE claim_value = ?', [claimValue]);
    return rows[0] ?? null;
  }

  async function create({ claimValue, role }) {
    const [result] = await pool.query(
      'INSERT INTO oidc_role_map (claim_value, blueeye_role) VALUES (?, ?)',
      [claimValue, role]
    );
    return findById(result.insertId);
  }

  async function update(id, { claimValue, role }) {
    const existing = await findById(id);
    if (!existing) return null;
    const fields = [];
    const params = [];
    if (claimValue !== undefined) { fields.push('claim_value = ?'); params.push(claimValue); }
    if (role !== undefined) { fields.push('blueeye_role = ?'); params.push(role); }
    if (fields.length > 0) {
      params.push(id);
      await pool.query(`UPDATE oidc_role_map SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    return findById(id);
  }

  async function remove(id) {
    const [result] = await pool.query('DELETE FROM oidc_role_map WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  return { findAll, findById, findByClaim, create, update, remove };
}

module.exports = { createOidcRoleMapRepository };
