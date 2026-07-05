'use strict';

const BASE_COLUMNS = `i.id, i.location_id, i.agent_id, i.metric, i.severity,
  i.started_at, i.resolved_at, i.duration_seconds, i.affected_target, i.created_at`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// Maps a joined incident row to the API shape (camelCase + location/agent names).
function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    locationId: row.location_id == null ? null : Number(row.location_id),
    locationName: row.location_name ?? null,
    agentId: Number(row.agent_id),
    agentName: row.agent_name ?? null,
    metric: row.metric,
    severity: row.severity,
    startedAt: toIso(row.started_at),
    resolvedAt: toIso(row.resolved_at),
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    affectedTarget: row.affected_target,
    status: row.resolved_at == null ? 'active' : 'resolved',
    createdAt: toIso(row.created_at),
  };
}

// Data-access for `incidents`.
function createIncidentsRepository(db) {
  const { pool } = db;

  // The currently-active incident for a (agent, metric, target), or null.
  async function findActive(agentId, metric, target) {
    const [rows] = await pool.query(
      `SELECT id, started_at, severity FROM incidents
       WHERE agent_id = ? AND metric = ? AND affected_target = ? AND resolved_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [agentId, metric, target]
    );
    const r = rows[0];
    return r ? { id: Number(r.id), startedAt: toIso(r.started_at), severity: r.severity } : null;
  }

  // Opens a new incident. Caller guarantees no active one exists for the tuple.
  async function open({ location_id = null, agent_id, metric, severity, started_at, affected_target }) {
    const [res] = await pool.query(
      `INSERT INTO incidents (location_id, agent_id, metric, severity, started_at, affected_target)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [location_id, agent_id, metric, severity, started_at, affected_target]
    );
    return Number(res.insertId);
  }

  // Raises the severity of an active incident (e.g. warning → critical when a
  // run escalates). Only ever increases — guarded to active rows. Returns true
  // if a row changed.
  async function updateSeverity(id, severity) {
    const [res] = await pool.query(
      `UPDATE incidents SET severity = ? WHERE id = ? AND resolved_at IS NULL`,
      [severity, id]
    );
    return res.affectedRows > 0;
  }

  // Resolves an active incident, stamping resolved_at + duration_seconds. The
  // duration is computed in SQL from the stored started_at so it is consistent
  // regardless of the caller's clock. No-op (returns false) if already resolved.
  async function resolve(id, resolvedAt) {
    const [res] = await pool.query(
      `UPDATE incidents
       SET resolved_at = ?,
           duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, started_at, ?))
       WHERE id = ? AND resolved_at IS NULL`,
      [resolvedAt, resolvedAt, id]
    );
    return res.affectedRows > 0;
  }

  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS}, l.name AS location_name,
              COALESCE(a.display_name, a.hostname) AS agent_name
       FROM incidents i
       LEFT JOIN locations l ON l.id = i.location_id
       LEFT JOIN agents a ON a.id = i.agent_id
       WHERE i.id = ?`,
      [id]
    );
    return mapRow(rows[0]) ?? null;
  }

  // Lists incidents overlapping [from, to], optionally filtered by severity and
  // location. An incident overlaps the window if it started before `to` and was
  // either unresolved or resolved after `from`. Newest-first. Each bound only
  // filters when provided — a missing `from`/`to` means "unbounded", NOT a
  // `<= NULL` comparison (which matches no rows: list() with no window used to
  // return an always-empty set).
  async function list({ from, to, severity = null, locationId = null, limit = 1000 } = {}) {
    const where = [];
    const params = [];
    if (to != null) { where.push('i.started_at <= ?'); params.push(to); }
    if (from != null) { where.push('(i.resolved_at IS NULL OR i.resolved_at >= ?)'); params.push(from); }
    if (severity) { where.push('i.severity = ?'); params.push(severity); }
    if (locationId != null) { where.push('i.location_id = ?'); params.push(locationId); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 1000;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS}, l.name AS location_name,
              COALESCE(a.display_name, a.hostname) AS agent_name
       FROM incidents i
       LEFT JOIN locations l ON l.id = i.location_id
       LEFT JOIN agents a ON a.id = i.agent_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY i.started_at DESC, i.id DESC
       LIMIT ?`,
      params
    );
    return rows.map(mapRow);
  }

  return { findActive, open, resolve, updateSeverity, findById, list };
}

module.exports = { createIncidentsRepository, mapRow };
