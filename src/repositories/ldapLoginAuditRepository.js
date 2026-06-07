'use strict';

// Data-access for `ldap_login_audit` — one row per LDAP/AD login attempt
// (success or failure). Never writes passwords.
function createLdapLoginAuditRepository(db) {
  const { pool } = db;

  async function record({
    username = null, ok = false, reason = null, grantedRole = null,
    groupsMatched = 0, sourceIp = null,
  }) {
    const [res] = await pool.query(
      `INSERT INTO ldap_login_audit (username, ok, reason, granted_role, groups_matched, source_ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [username == null ? null : String(username).slice(0, 255), ok ? 1 : 0, reason,
        grantedRole, groupsMatched || 0, sourceIp == null ? null : String(sourceIp).slice(0, 64)]
    );
    return res.insertId;
  }

  async function findAll({ limit = 100 } = {}) {
    const [rows] = await pool.query(
      'SELECT * FROM ldap_login_audit ORDER BY created_at DESC, id DESC LIMIT ?',
      [limit]
    );
    return rows;
  }

  return { record, findAll };
}

module.exports = { createLdapLoginAuditRepository };
