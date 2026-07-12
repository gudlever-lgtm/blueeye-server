'use strict';

// Columns safe to return to API clients — NEVER includes credentials_encrypted.
const SAFE_COLUMNS = 'id, type, base_url, auth_type, enabled, verified_at, updated_by, created_at, updated_at';

function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: row.enabled === 1 || row.enabled === true,
  };
}

// Data-access for the single-row `cmdb_config` (the one configured CMDB source —
// single source of truth). Credentials are stored as an opaque secret-box token
// (credentials_encrypted); the safe read omits it, and only getWithSecret returns
// it — for the test/search paths, which decrypt to actually call the upstream.
// Mirrors ldapConfigRepository's singleton get/getWithSecret/upsert shape.
function createCmdbConfigRepository(db) {
  const { pool } = db;

  // The current config (safe view), or null when none is stored yet. Lowest id
  // wins if more than one row somehow exists.
  async function get() {
    const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS} FROM cmdb_config ORDER BY id LIMIT 1`);
    return mapRow(rows[0]) ?? null;
  }

  // Includes the encrypted credentials blob — internal use only (test/search),
  // never returned by the API.
  async function getWithSecret() {
    const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS}, credentials_encrypted FROM cmdb_config ORDER BY id LIMIT 1`);
    return mapRow(rows[0]) ?? null;
  }

  // Upsert the single config row. Patch may carry credentialsEncrypted; omit it to
  // keep the stored credentials unchanged on edit. Editing any field clears the
  // stale verified_at (the connection must be re-tested). Returns the safe view.
  async function upsert(patch) {
    const existing = await getWithSecret();
    if (!existing) {
      await pool.query(
        `INSERT INTO cmdb_config (type, base_url, auth_type, credentials_encrypted, enabled, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [patch.type, patch.baseUrl, patch.authType ?? 'none', patch.credentialsEncrypted ?? null, patch.enabled ? 1 : 0, patch.updatedBy ?? null]
      );
      return get();
    }

    const fields = ['verified_at = NULL'];
    const params = [];
    if (patch.type !== undefined) { fields.push('type = ?'); params.push(patch.type); }
    if (patch.baseUrl !== undefined) { fields.push('base_url = ?'); params.push(patch.baseUrl); }
    if (patch.authType !== undefined) { fields.push('auth_type = ?'); params.push(patch.authType); }
    if (patch.credentialsEncrypted !== undefined) { fields.push('credentials_encrypted = ?'); params.push(patch.credentialsEncrypted); }
    if (patch.enabled !== undefined) { fields.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
    if (patch.updatedBy !== undefined) { fields.push('updated_by = ?'); params.push(patch.updatedBy); }

    params.push(existing.id);
    await pool.query(`UPDATE cmdb_config SET ${fields.join(', ')} WHERE id = ?`, params);
    return get();
  }

  // Stamp verified_at after a successful connection test. Silently no-ops when no
  // config exists (nothing to verify).
  async function markVerified(at = new Date()) {
    const existing = await get();
    if (!existing) return null;
    await pool.query('UPDATE cmdb_config SET verified_at = ? WHERE id = ?', [at, existing.id]);
    return get();
  }

  return { get, getWithSecret, upsert, markVerified };
}

module.exports = { createCmdbConfigRepository };
