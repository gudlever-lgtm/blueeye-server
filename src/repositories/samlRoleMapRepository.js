'use strict';

// Data-access for `saml_role_map` — maps a SAML attribute value (a group/role
// name from the configured role attribute, e.g. `groups`) to a BlueEye role. On
// login the user's attribute values are looked up and the HIGHEST matching role
// wins (admin > operator > viewer). NO match means access is DENIED — there is
// deliberately no default role. The `claim_value` column name is shared with the
// OIDC role map so both SSO flows present the same generic role-map surface.
function createSamlRoleMapRepository(db) {
  const { pool } = db;

  async function findAll() {
    const [rows] = await pool.query('SELECT * FROM saml_role_map ORDER BY id');
    return rows;
  }

  async function findById(id) {
    const [rows] = await pool.query('SELECT * FROM saml_role_map WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  async function findByClaim(claimValue) {
    const [rows] = await pool.query('SELECT * FROM saml_role_map WHERE claim_value = ?', [claimValue]);
    return rows[0] ?? null;
  }

  async function create({ claimValue, role }) {
    const [result] = await pool.query(
      'INSERT INTO saml_role_map (claim_value, blueeye_role) VALUES (?, ?)',
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
      await pool.query(`UPDATE saml_role_map SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    return findById(id);
  }

  async function remove(id) {
    const [result] = await pool.query('DELETE FROM saml_role_map WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  return { findAll, findById, findByClaim, create, update, remove };
}

module.exports = { createSamlRoleMapRepository };
