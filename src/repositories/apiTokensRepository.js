'use strict';

// Data-access for `api_tokens` (license feature `api_access`). Stores only the
// SHA-256 hash of each token; the plaintext is shown once at creation and never
// persisted. Reads for the admin UI never expose the hash.
const PUBLIC_COLUMNS =
  'id, name, token_prefix, role, created_by_user_id, created_at, last_used_at, expires_at, revoked_at';

function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    revoked: row.revoked_at != null,
    expired: row.expires_at != null && new Date(row.expires_at).getTime() < Date.now(),
  };
}

function createApiTokensRepository(db) {
  const { pool } = db;

  async function create({ name, tokenHash, tokenPrefix, role = 'viewer', createdByUserId = null, expiresAt = null }) {
    const [res] = await pool.query(
      `INSERT INTO api_tokens (name, token_prefix, token_hash, role, created_by_user_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [String(name).slice(0, 120), tokenPrefix, tokenHash, role, createdByUserId, expiresAt]
    );
    return findById(res.insertId);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM api_tokens WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  async function findAll() {
    const [rows] = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM api_tokens ORDER BY id DESC`);
    return rows.map(mapRow);
  }

  // Active = exists, not revoked, not past expiry. Returns the row (incl. role)
  // for an authenticating token hash, or null. Used on every API-token request.
  async function findActiveByHash(tokenHash) {
    const [rows] = await pool.query(
      `SELECT id, name, role, expires_at, revoked_at FROM api_tokens WHERE token_hash = ?`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row) return null;
    if (row.revoked_at != null) return null;
    if (row.expires_at != null && new Date(row.expires_at).getTime() < Date.now()) return null;
    return row;
  }

  // Best-effort "last seen" stamp; callers ignore the result.
  async function touch(id) {
    await pool.query('UPDATE api_tokens SET last_used_at = NOW() WHERE id = ?', [id]);
  }

  // Soft-revoke: keeps the row (and the audit trail) but makes the token unusable.
  async function revoke(id) {
    const [res] = await pool.query(
      'UPDATE api_tokens SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL',
      [id]
    );
    return res.affectedRows > 0;
  }

  return { create, findById, findAll, findActiveByHash, touch, revoke };
}

module.exports = { createApiTokensRepository };
