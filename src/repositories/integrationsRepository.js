'use strict';

// Columns safe to return to API clients — NEVER includes credentials_encrypted.
// (Mirrors usersRepository's PUBLIC_COLUMNS / findByEmailWithHash split.)
const SAFE_COLUMNS = 'id, type, name, base_url, auth_type, enabled, config_json, created_at, updated_at';

// config_json is a JSON column. mysql2 usually returns it already parsed, but
// tolerate a string (or bad JSON) and always hand callers a plain object.
function parseConfig(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: row.enabled === 1 || row.enabled === true,
    config_json: parseConfig(row.config_json),
  };
}

// Data-access for the `integrations` table. Stores credentials_encrypted as an
// opaque secret-box token (the route encrypts before calling create/update); the
// safe reads omit it, and only findByIdWithSecret returns it — for the dispatcher
// / test-fire path, which decrypts to actually call the target.
function createIntegrationsRepository(db) {
  const { pool } = db;

  async function findAll() {
    const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS} FROM integrations ORDER BY id`);
    return rows.map(mapRow);
  }

  async function findEnabled() {
    const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS} FROM integrations WHERE enabled = 1 ORDER BY id`);
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS} FROM integrations WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  // Includes the encrypted credentials blob — internal use only (dispatcher /
  // test-fire), never returned by the API.
  async function findByIdWithSecret(id) {
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS}, credentials_encrypted FROM integrations WHERE id = ?`,
      [id]
    );
    return mapRow(rows[0]) ?? null;
  }

  // Every ENABLED integration, with its credentials blob — used by the trigger
  // dispatcher to fan an event out to all matching targets.
  async function findEnabledWithSecret() {
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS}, credentials_encrypted FROM integrations WHERE enabled = 1 ORDER BY id`
    );
    return rows.map(mapRow);
  }

  async function findByName(name) {
    const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS} FROM integrations WHERE name = ?`, [name]);
    return mapRow(rows[0]) ?? null;
  }

  async function create({ type, name, baseUrl, authType = 'none', credentialsEncrypted = null, enabled = true, config = {} }) {
    const [result] = await pool.query(
      `INSERT INTO integrations (type, name, base_url, auth_type, credentials_encrypted, enabled, config_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [type, name, baseUrl, authType, credentialsEncrypted, enabled ? 1 : 0, JSON.stringify(config || {})]
    );
    return findById(result.insertId);
  }

  // Patch may carry name/baseUrl/authType/enabled/config and/or
  // credentialsEncrypted (omit the latter to keep the stored secret unchanged).
  // Returns the updated safe row, or null when no integration has that id.
  async function update(id, patch) {
    const existing = await findById(id);
    if (!existing) return null;

    const fields = [];
    const params = [];
    if (patch.name !== undefined) { fields.push('name = ?'); params.push(patch.name); }
    if (patch.baseUrl !== undefined) { fields.push('base_url = ?'); params.push(patch.baseUrl); }
    if (patch.authType !== undefined) { fields.push('auth_type = ?'); params.push(patch.authType); }
    if (patch.enabled !== undefined) { fields.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
    if (patch.config !== undefined) { fields.push('config_json = ?'); params.push(JSON.stringify(patch.config || {})); }
    if (patch.credentialsEncrypted !== undefined) { fields.push('credentials_encrypted = ?'); params.push(patch.credentialsEncrypted); }

    if (fields.length > 0) {
      params.push(id);
      await pool.query(`UPDATE integrations SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    return findById(id);
  }

  async function remove(id) {
    const [result] = await pool.query('DELETE FROM integrations WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  return {
    findAll,
    findEnabled,
    findById,
    findByIdWithSecret,
    findEnabledWithSecret,
    findByName,
    create,
    update,
    remove,
  };
}

module.exports = { createIntegrationsRepository };
