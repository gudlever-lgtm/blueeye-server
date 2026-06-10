'use strict';

// Data-access for `audit_log` — the unified who-did-what trail (auth, user/role
// admin, licence actions, report generation, API-token management). record()
// inserts one event; reads are newest-first and filterable by category / actor.
// Privacy by design: callers pass metadata only — never secrets or payloads.
const COLS =
  'id, created_at, category, action, outcome, actor_user_id, actor_email, actor_role, target, detail, ip';

// Distinct categories present in the trail, for the UI filter dropdown.
async function distinctCategories(pool) {
  const [rows] = await pool.query('SELECT DISTINCT category FROM audit_log ORDER BY category');
  return rows.map((r) => r.category);
}

function clampLimit(v, def = 100, max = 500) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) return def;
  return Math.min(n, max);
}

function createAuditLogRepository(db) {
  const { pool } = db;

  // Inserts one audit event and returns its new id. Truncates free-text fields
  // to their column widths so an oversized detail never throws.
  async function record({
    category,
    action,
    outcome = 'success',
    actorUserId = null,
    actorEmail = null,
    actorRole = null,
    target = null,
    detail = null,
    ip = null,
  }) {
    const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));
    const [res] = await pool.query(
      `INSERT INTO audit_log
         (category, action, outcome, actor_user_id, actor_email, actor_role, target, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trunc(category, 32),
        trunc(action, 64),
        outcome === 'failure' || outcome === 'denied' ? outcome : 'success',
        actorUserId,
        trunc(actorEmail, 255),
        trunc(actorRole, 32),
        trunc(target, 255),
        trunc(detail, 512),
        trunc(ip, 64),
      ]
    );
    return res.insertId;
  }

  // Newest-first list, optionally filtered by category and/or actor user id.
  async function list({ category = null, actorUserId = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (category) { where.push('category = ?'); params.push(String(category).slice(0, 32)); }
    if (actorUserId != null) { where.push('actor_user_id = ?'); params.push(actorUserId); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(clampLimit(limit));
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM audit_log ${clause} ORDER BY id DESC LIMIT ?`,
      params
    );
    return rows;
  }

  async function categories() {
    return distinctCategories(pool);
  }

  return { record, list, categories };
}

module.exports = { createAuditLogRepository };
