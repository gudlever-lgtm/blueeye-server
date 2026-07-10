'use strict';

// Data-access for `incident_cases` — incidents as a first-class entity wrapping
// analysis findings (migration 047). One row groups the findings that fired on
// the same device (host_id) within a correlation window; `severity` mirrors the
// highest severity among those findings and `title` is derived from the primary
// finding. This repo is pure data-access — the grouping/auto-create policy lives
// in src/incidentCases/incidentCaseService.js, state transitions in the router.
//
// The pre-existing `incidents` table (migration 025, probe outages) has its own
// repository (incidentsRepository.js) and is unrelated to this one.

const SEVERITY_RANK = { INFO: 0, WARN: 1, CRIT: 2 };
const OPEN_STATUSES = ['open', 'investigating']; // an incident still absorbing findings

const BASE_COLUMNS = `id, host_id, title, status, severity, primary_finding_id,
  first_event_at, last_event_at, resolved_at, created_by, closed_by, created_at`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// True when severity `a` is strictly more severe than `b` (CRIT > WARN > INFO).
function isWorse(a, b) {
  return (SEVERITY_RANK[a] ?? -1) > (SEVERITY_RANK[b] ?? -1);
}

// Maps a DB row to the public API shape (camelCase).
function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    hostId: row.host_id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    primaryFindingId: row.primary_finding_id ?? null,
    firstEventAt: toIso(row.first_event_at),
    lastEventAt: toIso(row.last_event_at),
    resolvedAt: toIso(row.resolved_at),
    createdBy: row.created_by,
    closedBy: row.closed_by == null ? null : Number(row.closed_by),
    createdAt: toIso(row.created_at),
  };
}

function createIncidentCasesRepository(db) {
  const { pool } = db;

  // Opens a new incident case and returns its new id.
  async function create({
    host_id,
    title,
    status = 'open',
    severity = 'INFO',
    primary_finding_id = null,
    first_event_at,
    last_event_at,
    created_by = 'system',
  }) {
    const [res] = await pool.query(
      `INSERT INTO incident_cases
         (host_id, title, status, severity, primary_finding_id, first_event_at, last_event_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [host_id, title, status, severity, primary_finding_id, first_event_at, last_event_at, created_by]
    );
    return Number(res.insertId);
  }

  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_cases WHERE id = ?`,
      [id]
    );
    return mapRow(rows[0]) ?? null;
  }

  // The most recent still-open incident (open|investigating) for a device, or
  // null. This is the candidate a freshly-detected finding may be grouped into.
  async function findOpenByHost(hostId) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_cases
       WHERE host_id = ? AND status IN (?, ?)
       ORDER BY last_event_at DESC, id DESC LIMIT 1`,
      [hostId, OPEN_STATUSES[0], OPEN_STATUSES[1]]
    );
    return mapRow(rows[0]) ?? null;
  }

  // Records new activity on an incident: advances last_event_at (never backwards)
  // and raises severity to `severity` when it is worse than the stored one. Only
  // ever escalates severity. Returns true if a row changed.
  async function updateActivity(id, { lastEventAt, severity = null }) {
    const [res] = await pool.query(
      `UPDATE incident_cases
         SET last_event_at = GREATEST(last_event_at, ?),
             severity = CASE
               WHEN ? = 'CRIT' THEN 'CRIT'
               WHEN ? = 'WARN' AND severity = 'INFO' THEN 'WARN'
               ELSE severity
             END
       WHERE id = ?`,
      [lastEventAt, severity, severity, id]
    );
    return res.affectedRows > 0;
  }

  // Lists incident cases, newest activity first, with optional filters. `from`/
  // `to` bound last_event_at. Used by the read API (added with the endpoints).
  async function list({ status = null, severity = null, hostId = null, from = null, to = null, limit = 1000 } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (severity) { where.push('severity = ?'); params.push(severity); }
    if (hostId) { where.push('host_id = ?'); params.push(hostId); }
    if (from != null) { where.push('last_event_at >= ?'); params.push(from); }
    if (to != null) { where.push('first_event_at <= ?'); params.push(to); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 1000;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_cases
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY last_event_at DESC, id DESC
       LIMIT ?`,
      params
    );
    return rows.map(mapRow);
  }

  return { create, findById, findOpenByHost, updateActivity, list };
}

module.exports = { createIncidentCasesRepository, mapRow, isWorse, SEVERITY_RANK, OPEN_STATUSES };
