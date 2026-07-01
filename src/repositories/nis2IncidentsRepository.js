'use strict';

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// Normalizes a caller-supplied datetime (Date, ISO string with T/Z, etc.) into
// the 'YYYY-MM-DD HH:MM:SS' form MySQL's DATETIME columns require — callers
// like the AI NIS2-draft path (src/routes/investigation.js) pass ISO strings
// straight from Mistral/window.to without going through nis2Validation first.
function toMysqlDateTime(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    incidentId: row.incident_id,
    title: row.title,
    severity: row.severity,
    detectedAt: toIso(row.detected_at),
    startedAt: toIso(row.started_at),
    resolvedAt: toIso(row.resolved_at),
    affectedSystems: row.affected_systems ?? null,
    businessImpact: row.business_impact ?? null,
    rootCause: row.root_cause ?? null,
    actionsTaken: row.actions_taken ?? null,
    nis2Relevant: !!row.nis2_relevant,
    notificationRequired: !!row.notification_required,
    status: row.status,
    lessonsLearned: row.lessons_learned ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const COLS = `id, incident_id, title, severity, detected_at, started_at, resolved_at,
  affected_systems, business_impact, root_cause, actions_taken, nis2_relevant,
  notification_required, status, lessons_learned, created_at, updated_at`;

// Data-access for `blueeye_nis2_incidents` (NIS2 security incidents — distinct
// from the probe-derived network `incidents`). A human reference INC-YYYY-NNNN
// is minted per-year on insert.
function createNis2IncidentsRepository(db) {
  const { pool } = db;

  // Next per-year reference. Reads the current max sequence for the year and adds
  // one. The unique index on incident_id is the real guard against a collision
  // (a racing insert just retries via the caller); this is best-effort numbering.
  async function nextRef(now = new Date()) {
    const year = now.getUTCFullYear();
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM blueeye_nis2_incidents WHERE incident_id LIKE ?`,
      [`INC-${year}-%`]
    );
    const seq = (Number(rows[0] && rows[0].n) || 0) + 1;
    return `INC-${year}-${String(seq).padStart(4, '0')}`;
  }

  async function findAll({ status = null, severity = null, nis2Relevant = null, sinceDays = null } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (severity) { where.push('severity = ?'); params.push(severity); }
    if (nis2Relevant != null) { where.push('nis2_relevant = ?'); params.push(nis2Relevant ? 1 : 0); }
    if (sinceDays != null) { where.push('detected_at >= (NOW() - INTERVAL ? DAY)'); params.push(sinceDays); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM blueeye_nis2_incidents ${clause}
       ORDER BY COALESCE(detected_at, created_at) DESC, id DESC`,
      params
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM blueeye_nis2_incidents WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  async function create(input) {
    const ref = await nextRef();
    const [res] = await pool.query(
      `INSERT INTO blueeye_nis2_incidents
         (incident_id, title, severity, detected_at, started_at, resolved_at,
          affected_systems, business_impact, root_cause, actions_taken,
          nis2_relevant, notification_required, status, lessons_learned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ref, input.title, input.severity, toMysqlDateTime(input.detectedAt), toMysqlDateTime(input.startedAt),
        toMysqlDateTime(input.resolvedAt), input.affectedSystems ?? null, input.businessImpact ?? null,
        input.rootCause ?? null, input.actionsTaken ?? null, input.nis2Relevant ? 1 : 0,
        input.notificationRequired ? 1 : 0, input.status, input.lessonsLearned ?? null,
      ]
    );
    return findById(res.insertId);
  }

  async function update(id, input) {
    await pool.query(
      `UPDATE blueeye_nis2_incidents SET
         title = ?, severity = ?, detected_at = ?, started_at = ?, resolved_at = ?,
         affected_systems = ?, business_impact = ?, root_cause = ?, actions_taken = ?,
         nis2_relevant = ?, notification_required = ?, status = ?, lessons_learned = ?
       WHERE id = ?`,
      [
        input.title, input.severity, toMysqlDateTime(input.detectedAt), toMysqlDateTime(input.startedAt),
        toMysqlDateTime(input.resolvedAt), input.affectedSystems ?? null, input.businessImpact ?? null,
        input.rootCause ?? null, input.actionsTaken ?? null, input.nis2Relevant ? 1 : 0,
        input.notificationRequired ? 1 : 0, input.status, input.lessonsLearned ?? null, id,
      ]
    );
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM blueeye_nis2_incidents WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  return { findAll, findById, create, update, remove, nextRef };
}

module.exports = { createNis2IncidentsRepository, mapRow };
