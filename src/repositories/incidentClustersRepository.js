'use strict';

// Data-access for `incident_clusters` (migration 057) — cross-agent incident
// clusters produced by src/analysis/crossAgentCorrelator.js. Pure data-access;
// the detect/dedup/resolve policy lives in src/analysis/crossAgentClusterService.js
// and the resolution sweep in src/analysis/crossAgentResolveJob.js.
//
// member_finding_ids is a JSON array of `findings.id` (UUID strings). MySQL JSON
// columns come back parsed via mysql2, but we parse defensively.

// Statuses that still count as "live" for dedup + auto-resolve. An acknowledged
// cluster is still open work (an operator owns it) — only resolved/closed are done.
const OPEN_STATUSES = ['open', 'acknowledged'];

const BASE_COLUMNS = `id, confidence, member_finding_ids, suspected_common_cause, advisory,
  status, detected_at, acknowledged_at, acknowledged_by, resolved_at, resolved_by,
  resolution_note, created_at, updated_at`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function parseIds(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === 'string') {
    try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    confidence: row.confidence,
    memberFindingIds: parseIds(row.member_finding_ids),
    suspectedCommonCause: row.suspected_common_cause ?? null,
    advisory: row.advisory ?? null,
    status: row.status,
    detectedAt: toIso(row.detected_at),
    acknowledgedAt: toIso(row.acknowledged_at),
    acknowledgedBy: row.acknowledged_by == null ? null : Number(row.acknowledged_by),
    resolvedAt: toIso(row.resolved_at),
    resolvedBy: row.resolved_by == null ? null : Number(row.resolved_by),
    resolutionNote: row.resolution_note ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// SQL fragment + params for the LIVE (still-open) statuses — open + acknowledged.
const LIVE_PLACEHOLDERS = OPEN_STATUSES.map(() => '?').join(', ');

function createIncidentClustersRepository(db) {
  const { pool } = db;

  // Opens a new cluster; returns its new id.
  async function create({ confidence = 'low', memberFindingIds = [], suspectedCommonCause = null, status = 'open', detectedAt }) {
    const [res] = await pool.query(
      `INSERT INTO incident_clusters
         (confidence, member_finding_ids, suspected_common_cause, status, detected_at)
       VALUES (?, ?, ?, ?, ?)`,
      [confidence, JSON.stringify(memberFindingIds || []), suspectedCommonCause, status, detectedAt],
    );
    return Number(res.insertId);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${BASE_COLUMNS} FROM incident_clusters WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  // All still-open clusters (open + acknowledged), newest activity first — the
  // dedup + resolution candidates. An acknowledged cluster is still live work, so
  // a recurring finding joins it rather than spawning a duplicate.
  async function listOpen(limit = 1000) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 1000;
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_clusters WHERE status IN (${LIVE_PLACEHOLDERS})
       ORDER BY detected_at DESC, id DESC LIMIT ?`,
      [...OPEN_STATUSES, lim],
    );
    return rows.map(mapRow);
  }

  // Re-evaluates a live cluster's membership: rewrites the member set, confidence
  // and cause and advances detected_at (never backwards). Returns true if changed.
  async function updateMembership(id, { confidence, memberFindingIds, suspectedCommonCause, detectedAt }) {
    const [res] = await pool.query(
      `UPDATE incident_clusters
          SET confidence = ?, member_finding_ids = ?, suspected_common_cause = ?,
              detected_at = GREATEST(detected_at, ?)
        WHERE id = ? AND status IN (${LIVE_PLACEHOLDERS})`,
      [confidence, JSON.stringify(memberFindingIds || []), suspectedCommonCause, detectedAt, id, ...OPEN_STATUSES],
    );
    return res.affectedRows > 0;
  }

  // Stores the cluster-level AI advisory (Step 2). Only sets it on a LIVE cluster
  // that has none yet, so a later sweep never overwrites or regenerates it. Returns
  // true if a row changed.
  async function setAdvisory(id, advisory) {
    const [res] = await pool.query(
      `UPDATE incident_clusters SET advisory = ?
       WHERE id = ? AND status IN (${LIVE_PLACEHOLDERS}) AND advisory IS NULL`,
      [advisory, id, ...OPEN_STATUSES],
    );
    return res.affectedRows > 0;
  }

  // Operator acknowledgement: open → acknowledged, stamping who + when. Guarded on
  // the current status (only an OPEN cluster can be acknowledged) so a concurrent
  // change / resolved cluster just affects 0 rows. Returns true if a row changed.
  async function acknowledge(id, { by = null, at }) {
    const [res] = await pool.query(
      `UPDATE incident_clusters
          SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?
        WHERE id = ? AND status = 'open'`,
      [at, by, id],
    );
    return res.affectedRows > 0;
  }

  // Operator resolution WITH a required free-text note: open|acknowledged →
  // resolved, stamping who + when + the note. Guarded on the live statuses so a
  // second resolve (or a race) affects 0 rows. Returns true if a row changed.
  async function resolve(id, { by = null, note, at }) {
    const [res] = await pool.query(
      `UPDATE incident_clusters
          SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution_note = ?
        WHERE id = ? AND status IN (${LIVE_PLACEHOLDERS})`,
      [at, by, note, id, ...OPEN_STATUSES],
    );
    return res.affectedRows > 0;
  }

  // Guarded status transition (current status is in the WHERE, so a stale read or a
  // concurrent change just affects 0 rows). Stamps resolved_at on →resolved. Returns
  // true if a row changed.
  async function updateStatus(id, { from, to, at = null }) {
    const sets = ['status = ?'];
    const params = [to];
    if (to === 'resolved' || to === 'closed') { sets.push('resolved_at = ?'); params.push(at); }
    if (to === 'open') { sets.push('resolved_at = NULL'); }
    params.push(id, from);
    const [res] = await pool.query(
      `UPDATE incident_clusters SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
      params,
    );
    return res.affectedRows > 0;
  }

  // Live clusters (open + acknowledged) whose last activity is older than
  // `olderThan` — the auto-resolve candidates (no member finding refreshed them
  // within the inactivity window). The CRIT-never-auto-close guard is applied by
  // the caller (crossAgentClusterService), which knows the member severities.
  async function listStaleOpen(olderThan, limit = 500) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_clusters
       WHERE status IN (${LIVE_PLACEHOLDERS}) AND detected_at < ?
       ORDER BY detected_at ASC LIMIT ?`,
      [...OPEN_STATUSES, olderThan, lim],
    );
    return rows.map(mapRow);
  }

  // Builds the shared WHERE for the read API list/count: optional status filter and
  // a [from, to] range on detected_at (last activity). Returns { clause, params }.
  function listFilter({ status = null, from = null, to = null } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (from) { where.push('detected_at >= ?'); params.push(from instanceof Date ? from : new Date(from)); }
    if (to) { where.push('detected_at <= ?'); params.push(to instanceof Date ? to : new Date(to)); }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  // Lists clusters, newest activity first, with optional status filter, a
  // detected_at time range and pagination (limit/offset). For the read API.
  async function list({ status = null, from = null, to = null, limit = 50, offset = 0 } = {}) {
    const { clause, params } = listFilter({ status, from, to });
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 50;
    const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_clusters
       ${clause}
       ORDER BY detected_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, lim, off],
    );
    return rows.map(mapRow);
  }

  // Total matching rows for the same filter — pagination metadata for the read API.
  async function count({ status = null, from = null, to = null } = {}) {
    const { clause, params } = listFilter({ status, from, to });
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM incident_clusters ${clause}`,
      params,
    );
    return Number(rows[0] ? rows[0].n : 0);
  }

  return {
    create, findById, listOpen, updateMembership, setAdvisory, updateStatus,
    listStaleOpen, list, count, acknowledge, resolve,
  };
}

module.exports = { createIncidentClustersRepository, mapRow, OPEN_STATUSES };
