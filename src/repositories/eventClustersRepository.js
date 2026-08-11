'use strict';

// Data-access for `event_clusters` (migration 057) — cross-agent event
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
  alert_last_at, alert_last_severity, alert_member_count, itsm_ticket_ref, itsm_integration_id, nis2_draft_id,
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
    alertLastAt: toIso(row.alert_last_at),
    alertLastSeverity: row.alert_last_severity ?? null,
    alertMemberCount: row.alert_member_count == null ? null : Number(row.alert_member_count),
    itsmTicketRef: row.itsm_ticket_ref ?? null,
    itsmIntegrationId: row.itsm_integration_id == null ? null : Number(row.itsm_integration_id),
    nis2DraftId: row.nis2_draft_id == null ? null : Number(row.nis2_draft_id),
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

// WHY EVERY SORTED READ BELOW IS SPLIT IN TWO
//
// MySQL sorts with "addon fields": each selected column is copied into the sort
// buffer next to the sort key, and a variable-length column is budgeted at its
// MAXIMUM width, not its actual one. member_finding_ids is JSON, whose maximum
// dwarfs the default 256 KB sort_buffer_size, so a single row never fits and the
// server aborts the query outright — ER_OUT_OF_SORTMEMORY, "Out of sort memory,
// consider increasing server sort buffer size" — instead of spilling to disk.
//
// That took out every read of this table that sorts: the Situations list 500'd,
// and the clustering engine's own listOpen/listStaleOpen sweeps failed silently
// (they log and carry on with []), so clusters stopped being deduped or
// auto-resolved. findById and count survived because neither sorts, which is
// exactly why the detail page kept working while the list did not.
//
// An index does not fix it: listOpen/listStaleOpen match `status IN (open,
// acknowledged)`, two disjoint ranges that no single index can hand back already
// ordered by detected_at, so those filesort no matter what is declared. Raising
// sort_buffer_size is a server-wide setting, and no customer should have to tune
// my.cnf to open a dashboard tab.
//
// So the sort never sees the JSON. Phase 1 orders and pages over narrow columns
// and yields ids; phase 2 fetches the full rows by primary key, which needs no
// sort at all; phase 1's order is reapplied in JS.

function createEventClustersRepository(db) {
  const { pool } = db;

  // Phase 2 of every listing: full rows for `ids`, returned in that exact order.
  // A row that disappeared between the two phases is dropped rather than left as
  // a hole in the list.
  async function hydrateByIds(ids) {
    if (!ids.length) return [];
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM event_clusters WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    const byId = new Map(rows.map((row) => [String(row.id), mapRow(row)]));
    return ids.map((id) => byId.get(String(id))).filter(Boolean);
  }

  // Opens a new cluster; returns its new id.
  async function create({ confidence = 'low', memberFindingIds = [], suspectedCommonCause = null, status = 'open', detectedAt }) {
    const [res] = await pool.query(
      `INSERT INTO event_clusters
         (confidence, member_finding_ids, suspected_common_cause, status, detected_at)
       VALUES (?, ?, ?, ?, ?)`,
      [confidence, JSON.stringify(memberFindingIds || []), suspectedCommonCause, status, detectedAt],
    );
    return Number(res.insertId);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${BASE_COLUMNS} FROM event_clusters WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  // All still-open clusters (open + acknowledged), newest activity first — the
  // dedup + resolution candidates. An acknowledged cluster is still live work, so
  // a recurring finding joins it rather than spawning a duplicate.
  async function listOpen(limit = 1000) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 1000;
    const [rows] = await pool.query(
      `SELECT id FROM event_clusters WHERE status IN (${LIVE_PLACEHOLDERS})
       ORDER BY detected_at DESC, id DESC LIMIT ?`,
      [...OPEN_STATUSES, lim],
    );
    return hydrateByIds(rows.map((row) => row.id));
  }

  // Re-evaluates a live cluster's membership: rewrites the member set, confidence
  // and cause and advances detected_at (never backwards). Returns true if changed.
  async function updateMembership(id, { confidence, memberFindingIds, suspectedCommonCause, detectedAt }) {
    const [res] = await pool.query(
      `UPDATE event_clusters
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
      `UPDATE event_clusters SET advisory = ?
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
      `UPDATE event_clusters
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
      `UPDATE event_clusters
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
      `UPDATE event_clusters SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
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
      `SELECT id FROM event_clusters
       WHERE status IN (${LIVE_PLACEHOLDERS}) AND detected_at < ?
       ORDER BY detected_at ASC LIMIT ?`,
      [...OPEN_STATUSES, olderThan, lim],
    );
    return hydrateByIds(rows.map((row) => row.id));
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
      `SELECT id FROM event_clusters
       ${clause}
       ORDER BY detected_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, lim, off],
    );
    return hydrateByIds(rows.map((row) => row.id));
  }

  // Total matching rows for the same filter — pagination metadata for the read API.
  async function count({ status = null, from = null, to = null } = {}) {
    const { clause, params } = listFilter({ status, from, to });
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM event_clusters ${clause}`,
      params,
    );
    return Number(rows[0] ? rows[0].n : 0);
  }

  // Records that a cluster-level alert was just sent — the digest/escalation state
  // the rollup engine reads next time.
  async function updateAlertState(id, { at, severity, memberCount }) {
    const [res] = await pool.query(
      `UPDATE event_clusters
          SET alert_last_at = ?, alert_last_severity = ?, alert_member_count = ?
        WHERE id = ?`,
      [at, severity, memberCount, id],
    );
    return res.affectedRows > 0;
  }

  // Stores the ONE external ITSM ticket a clustered event maps to.
  async function setItsmRef(id, { ticketRef, integrationId = null }) {
    const [res] = await pool.query(
      'UPDATE event_clusters SET itsm_ticket_ref = ?, itsm_integration_id = ? WHERE id = ?',
      [ticketRef, integrationId, id],
    );
    return res.affectedRows > 0;
  }

  // Links the ONE cluster-level NIS2 draft (blueeye_nis2_incidents.id).
  async function setNis2Draft(id, draftId) {
    const [res] = await pool.query(
      'UPDATE event_clusters SET nis2_draft_id = ? WHERE id = ? AND nis2_draft_id IS NULL',
      [draftId, id],
    );
    return res.affectedRows > 0;
  }

  return {
    create, findById, listOpen, updateMembership, setAdvisory, updateStatus,
    listStaleOpen, list, count, acknowledge, resolve,
    updateAlertState, setItsmRef, setNis2Draft,
  };
}

module.exports = { createEventClustersRepository, mapRow, OPEN_STATUSES };
