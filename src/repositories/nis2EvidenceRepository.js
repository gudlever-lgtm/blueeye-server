'use strict';

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description ?? null,
    fileName: row.file_name ?? null,
    fileUrl: row.file_url ?? null,
    contentType: row.content_type ?? null,
    entityType: row.entity_type ?? null,
    entityId: row.entity_id == null ? null : Number(row.entity_id),
    uploadedBy: row.uploaded_by == null ? null : Number(row.uploaded_by),
    uploadedByEmail: row.uploaded_by_email ?? null,
    createdAt: toIso(row.created_at),
  };
}

const COLS = `id, title, description, file_name, file_url, content_type,
  entity_type, entity_id, uploaded_by, uploaded_by_email, created_at`;

// Data-access for `blueeye_nis2_evidence` — evidence references (link/document
// metadata) optionally attached to a control/risk/incident/report.
function createNis2EvidenceRepository(db) {
  const { pool } = db;

  async function findAll({ entityType = null, entityId = null } = {}) {
    const where = [];
    const params = [];
    if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
    if (entityId != null) { where.push('entity_id = ?'); params.push(entityId); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM blueeye_nis2_evidence ${clause} ORDER BY id DESC`,
      params
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM blueeye_nis2_evidence WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  async function create(input) {
    const [res] = await pool.query(
      `INSERT INTO blueeye_nis2_evidence
         (title, description, file_name, file_url, content_type, entity_type, entity_id,
          uploaded_by, uploaded_by_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.title, input.description ?? null, input.fileName ?? null, input.fileUrl ?? null,
        input.contentType ?? null, input.entityType ?? null, input.entityId ?? null,
        input.uploadedBy ?? null, input.uploadedByEmail ?? null,
      ]
    );
    return findById(res.insertId);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM blueeye_nis2_evidence WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  return { findAll, findById, create, remove };
}

module.exports = { createNis2EvidenceRepository, mapRow };
