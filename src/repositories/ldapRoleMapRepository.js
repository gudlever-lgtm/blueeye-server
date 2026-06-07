'use strict';

// Data-access for `ldap_role_map` — maps an LDAP/AD group DN to a BlueEye role.
function createLdapRoleMapRepository(db) {
  const { pool } = db;

  async function findAll() {
    const [rows] = await pool.query('SELECT * FROM ldap_role_map ORDER BY id');
    return rows;
  }

  async function findById(id) {
    const [rows] = await pool.query('SELECT * FROM ldap_role_map WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  async function findByGroup(groupDn) {
    const [rows] = await pool.query('SELECT * FROM ldap_role_map WHERE ldap_group_dn = ?', [groupDn]);
    return rows[0] ?? null;
  }

  async function create({ groupDn, role }) {
    const [result] = await pool.query(
      'INSERT INTO ldap_role_map (ldap_group_dn, blueeye_role) VALUES (?, ?)',
      [groupDn, role]
    );
    return findById(result.insertId);
  }

  async function update(id, { groupDn, role }) {
    const existing = await findById(id);
    if (!existing) return null;
    const fields = [];
    const params = [];
    if (groupDn !== undefined) { fields.push('ldap_group_dn = ?'); params.push(groupDn); }
    if (role !== undefined) { fields.push('blueeye_role = ?'); params.push(role); }
    if (fields.length > 0) {
      params.push(id);
      await pool.query(`UPDATE ldap_role_map SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    return findById(id);
  }

  async function remove(id) {
    const [result] = await pool.query('DELETE FROM ldap_role_map WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  return { findAll, findById, findByGroup, create, update, remove };
}

module.exports = { createLdapRoleMapRepository };
