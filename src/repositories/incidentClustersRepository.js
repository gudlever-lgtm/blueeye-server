'use strict';

// Data-access for `incident_clusters` (migration 057) — cross-agent incident
// clusters produced by src/analysis/crossAgentCorrelator.js. Pure data-access;
// the detect/dedup/resolve policy lives in src/analysis/crossAgentClusterService.js
// and the resolution sweep in src/analysis/crossAgentResolveJob.js.
//
// member_finding_ids is a JSON array of `findings.id` (UUID strings). MySQL JSON
// columns come back parsed via mysql2, but we parse defensively.

const OPEN_STATUSES = ['open'];

const BASE_COLUMNS = `id, confidence, member_finding_ids, suspected_common_cause, advisory,
  status, detected_at, resolved_at, created_at, updated_at`;

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
    resolvedAt: toIso(row.resolved_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

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

  // All still-open clusters, newest activity first — the dedup + resolution candidates.
  async function listOpen(limit = 1000) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 1000;
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_clusters WHERE status = ?
       ORDER BY detected_at DESC, id DESC LIMIT ?`,
      [OPEN_STATUSES[0], lim],
    );
    return rows.map(mapRow);
  }

  // Re-evaluates an open cluster's membership: rewrites the member set, confidence
  // and cause and advances detected_at (never backwards). Returns true if changed.
  async function updateMembership(id, { confidence, memberFindingIds, suspectedCommonCause, detectedAt }) {
    const [res] = await pool.query(
      `UPDATE incident_clusters
          SET confidence = ?, member_finding_ids = ?, suspected_common_cause = ?,
              detected_at = GREATEST(detected_at, ?)
        WHERE id = ? AND status = 'open'`,
      [confidence, JSON.stringify(memberFindingIds || []), suspectedCommonCause, detectedAt, id],
    );
    return res.affectedRows > 0;
  }

  // Stores the cluster-level AI advisory (Step 2). Only sets it on an OPEN cluster
  // that has none yet, so a later sweep never overwrites or regenerates it. Returns
  // true if a row changed.
  async function setAdvisory(id, advisory) {
    const [res] = await pool.query(
      `UPDATE incident_clusters SET advisory = ?
       WHERE id = ? AND status = 'open' AND advisory IS NULL`,
      [advisory, id],
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

  // Open clusters whose last activity is older than `olderThan` — the auto-resolve
  // candidates (no member finding refreshed them within the inactivity window).
  async function listStaleOpen(olderThan, limit = 500) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_clusters
       WHERE status = 'open' AND detected_at < ?
       ORDER BY detected_at ASC LIMIT ?`,
      [olderThan, lim],
    );
    return rows.map(mapRow);
  }

  // Lists clusters, newest activity first, with optional status filter. For the
  // read API / tests.
  async function list({ status = null, limit = 1000 } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 1000;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_clusters
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY detected_at DESC, id DESC LIMIT ?`,
      params,
    );
    return rows.map(mapRow);
  }

  return { create, findById, listOpen, updateMembership, setAdvisory, updateStatus, listStaleOpen, list };
}

module.exports = { createIncidentClustersRepository, mapRow, OPEN_STATUSES };
