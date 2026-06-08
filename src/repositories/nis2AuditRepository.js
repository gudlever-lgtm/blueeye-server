'use strict';

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: row.user_id == null ? null : Number(row.user_id),
    userEmail: row.user_email ?? null,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id == null ? null : Number(row.entity_id),
    oldValue: parseJson(row.old_value),
    newValue: parseJson(row.new_value),
    createdAt: toIso(row.created_at),
  };
}

const COLS = `id, user_id, user_email, action, entity_type, entity_id,
  old_value, new_value, created_at`;

// Data-access for `blueeye_audit_log` — the NIS2 module's change trail. record()
// is best-effort from the routes (a failed audit write must not fail the user's
// request), so callers wrap it; reads are newest-first and filterable.
function createNis2AuditRepository(db) {
  const { pool } = db;

  async function record({ userId = null, userEmail = null, action, entityType, entityId = null, oldValue = null, newValue = null }) {
    const [res] = await pool.query(
      `INSERT INTO blueeye_audit_log
         (user_id, user_email, action, entity_type, entity_id, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, userEmail, action, entityType, entityId,
        oldValue == null ? null : JSON.stringify(oldValue),
        newValue == null ? null : JSON.stringify(newValue),
      ]
    );
    return Number(res.insertId);
  }

  async function findAll({ entityType = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 100;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM blueeye_audit_log ${clause} ORDER BY id DESC LIMIT ?`,
      params
    );
    return rows.map(mapRow);
  }

  return { record, findAll };
}

module.exports = { createNis2AuditRepository, mapRow };
