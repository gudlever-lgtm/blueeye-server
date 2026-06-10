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

// Read shape for the API/dashboard. `actorLabel` falls back to the joined agent
// hostname for agent activity (snapshot is null there to keep the ingest path
// query-free).
function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ts: toIso(row.ts),
    actorType: row.actor_type,
    actorId: row.actor_id == null ? null : Number(row.actor_id),
    actorLabel: row.actor_label ?? row.agent_hostname ?? null,
    actorRole: row.actor_role ?? null,
    action: row.action,
    targetType: row.target_type ?? null,
    targetId: row.target_id ?? null,
    targetLabel: row.target_label ?? null,
    method: row.method ?? null,
    path: row.path ?? null,
    status: row.status == null ? null : Number(row.status),
    ip: row.ip ?? null,
    detail: parseJson(row.detail),
    repeatIntervalMs: row.repeat_interval_ms == null ? null : Number(row.repeat_interval_ms),
    occurrences: row.occurrences == null ? 1 : Number(row.occurrences),
    firstSeenAt: toIso(row.first_seen_at),
    lastSeenAt: toIso(row.last_seen_at),
  };
}

const SELECT_COLS = `ae.id, ae.ts, ae.actor_type, ae.actor_id, ae.actor_label,
  ae.actor_role, ae.action, ae.target_type, ae.target_id, ae.target_label,
  ae.method, ae.path, ae.status, ae.ip, ae.detail, ae.repeat_interval_ms,
  ae.occurrences, ae.first_seen_at, ae.last_seen_at, a.hostname AS agent_hostname`;

// Joins the agent so agent activity shows a hostname even though the ingest path
// stores only actor_id (no per-report agent lookup).
const FROM = `audit_events ae
  LEFT JOIN agents a ON ae.actor_type = 'agent' AND ae.actor_id = a.id`;

function clampLimit(v, def = 100, max = 500) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) return def;
  return Math.min(n, max);
}

// Data-access for `audit_events` — the unified, server-wide audit trail.
//   record()          — a discrete event (one row per call; dedup_key NULL).
//   recordRecurring() — repeat-suppressed activity (first run audited, repeats
//                       folded onto the same row via the UNIQUE dedup_key).
// Both are best-effort from callers (an audit failure must never fail the user's
// request or break ingestion), so callers wrap them. Reads are newest-first and
// filterable.
function createAuditEventsRepository(db) {
  const { pool } = db;

  async function record({
    actorType = 'user', actorId = null, actorLabel = null, actorRole = null,
    action, targetType = null, targetId = null, targetLabel = null,
    method = null, path = null, status = null, ip = null, detail = null,
    repeatIntervalMs = null,
  }) {
    const [res] = await pool.query(
      `INSERT INTO audit_events
         (actor_type, actor_id, actor_label, actor_role, action, target_type,
          target_id, target_label, method, path, status, ip, detail, repeat_interval_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actorType, actorId, actorLabel, actorRole, action, targetType,
        targetId == null ? null : String(targetId), targetLabel, method, path,
        status, ip, detail == null ? null : JSON.stringify(detail), repeatIntervalMs,
      ]
    );
    return Number(res.insertId);
  }

  // Records recurring activity keyed by `dedupKey`. The first occurrence inserts
  // an audited row; every subsequent call with the same key bumps occurrences +
  // last_seen_at instead of adding a row (so "repeated tests" leave just one
  // entry, annotated with how often they repeat).
  async function recordRecurring({
    actorType = 'agent', actorId = null, actorLabel = null, actorRole = null,
    action, targetType = null, targetId = null, targetLabel = null,
    detail = null, repeatIntervalMs = null, dedupKey,
  }) {
    if (!dedupKey) throw new Error('recordRecurring requires a dedupKey');
    await pool.query(
      `INSERT INTO audit_events
         (actor_type, actor_id, actor_label, actor_role, action, target_type,
          target_id, target_label, detail, repeat_interval_ms, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         occurrences = occurrences + 1,
         -- Set the repeat interval once, on the first repeat, from the observed
         -- gap (self-measuring — no need to know the agent's configured cadence).
         -- Evaluated before last_seen_at is bumped below.
         repeat_interval_ms = COALESCE(
           repeat_interval_ms, VALUES(repeat_interval_ms),
           TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) * 1000),
         last_seen_at = NOW()`,
      [
        actorType, actorId, actorLabel, actorRole, action, targetType,
        targetId == null ? null : String(targetId), targetLabel,
        detail == null ? null : JSON.stringify(detail), repeatIntervalMs, dedupKey,
      ]
    );
  }

  // Newest-first, filterable by actor type, action and time window.
  async function findAll({
    actorType = null, action = null, from = null, to = null,
    limit = 100, offset = 0,
  } = {}) {
    const where = [];
    const params = [];
    if (actorType) { where.push('ae.actor_type = ?'); params.push(actorType); }
    if (action) { where.push('ae.action = ?'); params.push(action); }
    if (from) { where.push('ae.last_seen_at >= ?'); params.push(from); }
    if (to) { where.push('ae.last_seen_at <= ?'); params.push(to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const lim = clampLimit(limit);
    const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
    params.push(lim, off);
    const [rows] = await pool.query(
      `SELECT ${SELECT_COLS} FROM ${FROM} ${clause}
       ORDER BY ae.last_seen_at DESC, ae.id DESC LIMIT ? OFFSET ?`,
      params
    );
    return rows.map(mapRow);
  }

  // The distinct action keys present, for the dashboard filter dropdown.
  async function distinctActions() {
    const [rows] = await pool.query(
      'SELECT DISTINCT action FROM audit_events ORDER BY action ASC'
    );
    return rows.map((r) => r.action);
  }

  return { record, recordRecurring, findAll, distinctActions };
}

module.exports = { createAuditEventsRepository, mapRow };
