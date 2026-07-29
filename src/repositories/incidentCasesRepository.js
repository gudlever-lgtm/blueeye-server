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

const BASE_COLUMNS = `id, host_id, title, status, severity, primary_finding_id, config_change_id,
  first_event_at, last_event_at, resolved_at, created_by, closed_by, created_at`;

// The same columns, qualified for a query that joins (`ic` is this table).
const IC_COLUMNS = BASE_COLUMNS.split(',').map((c) => `ic.${c.trim()}`).join(', ');

// "Where is this incident?" — the device label + its site, joined onto every read
// that a human looks at (list + detail). `host_id` is the agent id as a string,
// so the join casts; a host_id that is not an agent simply yields NULLs. LEFT
// JOINs throughout: an incident must still render when the agent was deleted or
// has no location set.
const DEVICE_JOIN = `
  LEFT JOIN agents a ON a.id = ic.host_id
  LEFT JOIN locations l ON l.id = a.location_id`;
const DEVICE_COLUMNS = `a.display_name AS agent_display_name, a.hostname AS agent_hostname,
  a.location_id AS location_id, l.name AS location_name`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// The human answer to "which machine, and where does it stand?". `agentName`
// prefers the operator-set display name over the reported hostname; both are
// null when host_id does not resolve to a (still-existing) agent.
function deviceIdentity(row) {
  return {
    agentName: row.agent_display_name || row.agent_hostname || null,
    agentHostname: row.agent_hostname ?? null,
    locationId: row.location_id == null ? null : Number(row.location_id),
    locationName: row.location_name ?? null,
  };
}

// True when severity `a` is strictly more severe than `b` (CRIT > WARN > INFO).
function isWorse(a, b) {
  return (SEVERITY_RANK[a] ?? -1) > (SEVERITY_RANK[b] ?? -1);
}

// Maps a DB row to the public API shape (camelCase). Rows that came from a
// device-joined query (list/findById/listResolvedClosed) additionally carry the
// agent + location identity; the internal reads that skip the join keep the
// plain shape rather than reporting a misleading `agentName: null`.
function mapRow(row) {
  if (!row) return null;
  const device = Object.prototype.hasOwnProperty.call(row, 'agent_hostname') ? deviceIdentity(row) : null;
  return {
    id: Number(row.id),
    hostId: row.host_id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    primaryFindingId: row.primary_finding_id ?? null,
    configChangeId: row.config_change_id == null ? null : Number(row.config_change_id),
    firstEventAt: toIso(row.first_event_at),
    lastEventAt: toIso(row.last_event_at),
    resolvedAt: toIso(row.resolved_at),
    createdBy: row.created_by,
    closedBy: row.closed_by == null ? null : Number(row.closed_by),
    createdAt: toIso(row.created_at),
    ...(device || {}),
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
      `SELECT ${IC_COLUMNS}, ${DEVICE_COLUMNS}
       FROM incident_cases ic ${DEVICE_JOIN}
       WHERE ic.id = ?`,
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

  // Guarded status transition. The current status is part of the WHERE, so a
  // stale read or a concurrent change can never apply an out-of-order transition
  // (it just affects 0 rows). Stamps resolved_at on →resolved, closed_by on
  // →closed, and clears both on reopen (→open). Returns true if a row changed.
  async function updateStatus(id, { from, to, closedBy = null, at = null }) {
    const sets = ['status = ?'];
    const params = [to];
    if (to === 'resolved') { sets.push('resolved_at = ?'); params.push(at); }
    if (to === 'closed') { sets.push('closed_by = ?'); params.push(closedBy); }
    if (to === 'open') { sets.push('resolved_at = NULL', 'closed_by = NULL'); }
    params.push(id, from);
    const [res] = await pool.query(
      `UPDATE incident_cases SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
      params
    );
    return res.affectedRows > 0;
  }

  // Links the config change (config_snapshots id) suspected to have triggered an
  // incident. Guarded so the FIRST correlated change wins and a later anomaly
  // can't overwrite it (only sets when config_change_id IS NULL). Returns true if
  // a row changed.
  async function setConfigChange(id, configSnapshotId) {
    const [res] = await pool.query(
      `UPDATE incident_cases SET config_change_id = ?
       WHERE id = ? AND config_change_id IS NULL`,
      [configSnapshotId, id]
    );
    return res.affectedRows > 0;
  }

  // Investigating incidents whose last activity is older than `olderThan` — the
  // auto-resolve candidates (no new anomalies linked within the inactivity
  // window). Oldest-first so the job processes the stalest first.
  async function listStaleInvestigating(olderThan, limit = 500) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_cases
       WHERE status = 'investigating' AND last_event_at < ?
       ORDER BY last_event_at ASC LIMIT ?`,
      [olderThan, lim]
    );
    return rows.map(mapRow);
  }

  // Past resolved/closed incidents for the similarity read-model (Fase 4), joined
  // with the primary anomaly type (finding metric), the device platform (a
  // device-type proxy), the device identity (agent name + site) and the email of
  // whoever closed it. Newest-resolved first.
  async function listResolvedClosed({ excludeId = null, limit = 100, statuses = ['resolved', 'closed'] } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 1000 ? limit : 100;
    // The recommendation read-model passes statuses:['resolved'] (closed-without-
    // resolution is not a "solution"); the similarity endpoint keeps the default.
    const allowed = (Array.isArray(statuses) && statuses.length ? statuses : ['resolved', 'closed'])
      .filter((s) => s === 'resolved' || s === 'closed');
    const list = allowed.length ? allowed : ['resolved', 'closed'];
    const where = [`ic.status IN (${list.map(() => '?').join(', ')})`];
    const params = [...list];
    if (excludeId != null) { where.push('ic.id <> ?'); params.push(excludeId); }
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT ${IC_COLUMNS}, ${DEVICE_COLUMNS},
              f.metric AS primary_metric, u.email AS closed_by_email, a.platform AS device_platform
       FROM incident_cases ic ${DEVICE_JOIN}
       LEFT JOIN findings f ON f.id = ic.primary_finding_id
       LEFT JOIN users u ON u.id = ic.closed_by
       WHERE ${where.join(' AND ')}
       ORDER BY ic.last_event_at DESC, ic.id DESC
       LIMIT ?`,
      params
    );
    return rows.map((row) => ({
      ...mapRow(row),
      primaryMetric: row.primary_metric ?? null,
      closedByEmail: row.closed_by_email ?? null,
      platform: row.device_platform ?? null,
    }));
  }

  // Lists incident cases, newest activity first, with optional filters. `from`/
  // `to` bound last_event_at. Used by the read API (added with the endpoints).
  async function list({ status = null, severity = null, hostId = null, from = null, to = null, limit = 1000 } = {}) {
    const where = [];
    const params = [];
    // Every predicate is qualified: `agents` joins in a `status` column of its own.
    if (status) { where.push('ic.status = ?'); params.push(status); }
    if (severity) { where.push('ic.severity = ?'); params.push(severity); }
    if (hostId) { where.push('ic.host_id = ?'); params.push(hostId); }
    if (from != null) { where.push('ic.last_event_at >= ?'); params.push(from); }
    if (to != null) { where.push('ic.first_event_at <= ?'); params.push(to); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 1000;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT ${IC_COLUMNS}, ${DEVICE_COLUMNS}
       FROM incident_cases ic ${DEVICE_JOIN}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ic.last_event_at DESC, ic.id DESC
       LIMIT ?`,
      params
    );
    return rows.map(mapRow);
  }

  return { create, findById, findOpenByHost, updateActivity, updateStatus, setConfigChange, listStaleInvestigating, listResolvedClosed, list };
}

module.exports = { createIncidentCasesRepository, mapRow, deviceIdentity, isWorse, SEVERITY_RANK, OPEN_STATUSES };
