'use strict';

// Columns safe to return to API clients — NEVER includes bind_pw_encrypted.
const SAFE_COLUMNS = 'id, host, port, use_tls, bind_dn, base_dn, user_filter, group_filter, enabled, created_at, updated_at';

function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    use_tls: row.use_tls === 1 || row.use_tls === true,
    enabled: row.enabled === 1 || row.enabled === true,
  };
}

// Data-access for the single-row `ldap_config`. The bind password is stored as an
// opaque secret-box token (bind_pw_encrypted); the safe read omits it, and only
// getWithSecret returns it — for the LDAP auth service, which decrypts to bind.
function createLdapConfigRepository(db) {
  const { pool } = db;

  // The current config (safe view), or null when none is stored yet. Lowest id
  // wins if more than one row somehow exists.
  async function get() {
    const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS} FROM ldap_config ORDER BY id LIMIT 1`);
    return mapRow(rows[0]) ?? null;
  }

  // Includes the encrypted bind password — internal use only (the auth service).
  async function getWithSecret() {
    const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS}, bind_pw_encrypted FROM ldap_config ORDER BY id LIMIT 1`);
    return mapRow(rows[0]) ?? null;
  }

  // Upsert the single config row. Patch may carry bindPwEncrypted; omit it to
  // keep the stored password unchanged on edit. Returns the updated safe view.
  async function upsert(patch) {
    const existing = await getWithSecret();
    if (!existing) {
      await pool.query(
        `INSERT INTO ldap_config (host, port, use_tls, bind_dn, bind_pw_encrypted, base_dn, user_filter, group_filter, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          patch.host, patch.port ?? 389, patch.useTls ? 1 : 0,
          patch.bindDn ?? null, patch.bindPwEncrypted ?? null, patch.baseDn,
          patch.userFilter ?? '(sAMAccountName={{username}})', patch.groupFilter ?? null,
          patch.enabled ? 1 : 0,
        ]
      );
      return get();
    }

    const fields = [];
    const params = [];
    if (patch.host !== undefined) { fields.push('host = ?'); params.push(patch.host); }
    if (patch.port !== undefined) { fields.push('port = ?'); params.push(patch.port); }
    if (patch.useTls !== undefined) { fields.push('use_tls = ?'); params.push(patch.useTls ? 1 : 0); }
    if (patch.bindDn !== undefined) { fields.push('bind_dn = ?'); params.push(patch.bindDn); }
    if (patch.bindPwEncrypted !== undefined) { fields.push('bind_pw_encrypted = ?'); params.push(patch.bindPwEncrypted); }
    if (patch.baseDn !== undefined) { fields.push('base_dn = ?'); params.push(patch.baseDn); }
    if (patch.userFilter !== undefined) { fields.push('user_filter = ?'); params.push(patch.userFilter); }
    if (patch.groupFilter !== undefined) { fields.push('group_filter = ?'); params.push(patch.groupFilter); }
    if (patch.enabled !== undefined) { fields.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }

    if (fields.length > 0) {
      params.push(existing.id);
      await pool.query(`UPDATE ldap_config SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    return get();
  }

  return { get, getWithSecret, upsert };
}

module.exports = { createLdapConfigRepository };
