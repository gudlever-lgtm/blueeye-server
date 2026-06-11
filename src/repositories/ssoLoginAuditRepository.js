'use strict';

// Data-access for `sso_login_audit` — one row per federated (OIDC/SAML) login
// attempt (success or failure). Shared by both SSO flows; the `provider` column
// distinguishes them. Never writes secrets (no tokens, no assertions).
function createSsoLoginAuditRepository(db) {
  const { pool } = db;

  async function record({
    provider = 'oidc', subject = null, ok = false, reason = null,
    grantedRole = null, groupsMatched = 0, sourceIp = null,
  }) {
    const [res] = await pool.query(
      `INSERT INTO sso_login_audit (provider, subject, ok, reason, granted_role, groups_matched, source_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(provider).slice(0, 16),
        subject == null ? null : String(subject).slice(0, 255),
        ok ? 1 : 0, reason, grantedRole, groupsMatched || 0,
        sourceIp == null ? null : String(sourceIp).slice(0, 64),
      ]
    );
    return res.insertId;
  }

  async function findAll({ provider = null, limit = 100 } = {}) {
    if (provider) {
      const [rows] = await pool.query(
        'SELECT * FROM sso_login_audit WHERE provider = ? ORDER BY created_at DESC, id DESC LIMIT ?',
        [provider, limit]
      );
      return rows;
    }
    const [rows] = await pool.query(
      'SELECT * FROM sso_login_audit ORDER BY created_at DESC, id DESC LIMIT ?',
      [limit]
    );
    return rows;
  }

  return { record, findAll };
}

module.exports = { createSsoLoginAuditRepository };
