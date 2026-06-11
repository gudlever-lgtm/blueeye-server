'use strict';

// Data-access for `audit_log` — the unified who-did-what trail (auth, user/role
// admin, licence actions, report generation, API-token management). record()
// inserts one event; reads are newest-first and filterable by category / actor.
// Privacy by design: callers pass metadata only — never secrets or payloads.
//
// TAMPER-EVIDENCE (baseline hardening): every row is chained to the previous one
// — entry_hash = sha256(prev_hash || canonical(fields)). A break anywhere means a
// row was altered or removed, so the trail is append-only by construction.
// verifyChain() walks it and reports the first broken row. Rows written before
// migration 041 carry NULL hashes and are skipped (the chain anchors at the first
// hashed row). Always on — not licence-gated.
const crypto = require('crypto');
const { canonicalize } = require('../lib/canonicalize');

const COLS =
  'id, created_at, category, action, outcome, actor_user_id, actor_email, actor_role, target, detail, ip';

// The exact, normalized field set that is both stored AND hashed, so a later
// verify reproduces the same bytes from the stored columns. created_at is
// DB-generated and intentionally excluded.
function canonicalFields(row) {
  return canonicalize({
    category: row.category ?? null,
    action: row.action ?? null,
    outcome: row.outcome ?? null,
    actor_user_id: row.actor_user_id ?? null,
    actor_email: row.actor_email ?? null,
    actor_role: row.actor_role ?? null,
    target: row.target ?? null,
    detail: row.detail ?? null,
    ip: row.ip ?? null,
  });
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function entryHashFor(prevHash, row) {
  return sha256((prevHash || '') + canonicalFields(row));
}

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
    const stored = {
      category: trunc(category, 32),
      action: trunc(action, 64),
      outcome: outcome === 'failure' || outcome === 'denied' ? outcome : 'success',
      actor_user_id: actorUserId,
      actor_email: trunc(actorEmail, 255),
      actor_role: trunc(actorRole, 32),
      target: trunc(target, 255),
      detail: trunc(detail, 512),
      ip: trunc(ip, 64),
    };
    // Chain to the most recent row. A read error / no rows ⇒ start a fresh chain.
    let prevHash = '';
    try {
      const [last] = await pool.query('SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1');
      prevHash = (last[0] && last[0].entry_hash) || '';
    } catch { prevHash = ''; }
    const entryHash = entryHashFor(prevHash, stored);

    const [res] = await pool.query(
      `INSERT INTO audit_log
         (category, action, outcome, actor_user_id, actor_email, actor_role, target, detail, ip, prev_hash, entry_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.category, stored.action, stored.outcome, stored.actor_user_id, stored.actor_email,
        stored.actor_role, stored.target, stored.detail, stored.ip, prevHash || null, entryHash,
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

  // Walks the hash chain (oldest→newest over the rows that carry a hash) and
  // recomputes each entry_hash. Returns { ok, checked, brokenAt } where brokenAt
  // is the id of the first tampered/removed row, or null when intact.
  async function verifyChain({ limit = 100000 } = {}) {
    const [rows] = await pool.query(
      `SELECT ${COLS}, prev_hash, entry_hash FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY id ASC LIMIT ?`,
      [clampLimit(limit, 100000, 1000000)]
    );
    if (rows.length === 0) return { ok: true, checked: 0, brokenAt: null };
    let prev = rows[0].prev_hash || '';
    for (const row of rows) {
      if ((row.prev_hash || '') !== (prev || '')) {
        return { ok: false, checked: rows.length, brokenAt: row.id };
      }
      if (row.entry_hash !== entryHashFor(prev, row)) {
        return { ok: false, checked: rows.length, brokenAt: row.id };
      }
      prev = row.entry_hash;
    }
    return { ok: true, checked: rows.length, brokenAt: null };
  }

  return { record, list, categories, verifyChain };
}

module.exports = { createAuditLogRepository, entryHashFor, canonicalFields };
