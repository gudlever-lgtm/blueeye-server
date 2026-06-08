'use strict';

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
const toDate = (v) => (v ? String(v).slice(0, 10) : null);

// A control has evidence when it carries an evidence_file reference. Surfaced as
// a boolean so the dashboard can prioritise controls lacking evidence.
function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    controlName: row.control_name,
    nis2Area: row.nis2_area,
    description: row.description ?? null,
    owner: row.owner ?? null,
    frequency: row.frequency,
    lastPerformed: toDate(row.last_performed),
    nextDue: toDate(row.next_due),
    evidenceFile: row.evidence_file ?? null,
    hasEvidence: !!(row.evidence_file && String(row.evidence_file).trim()),
    status: row.status,
    comment: row.comment ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const COLS = `id, control_name, nis2_area, description, owner, frequency,
  last_performed, next_due, evidence_file, status, comment, created_at, updated_at`;

// Data-access for `blueeye_nis2_controls`.
function createNis2ControlsRepository(db) {
  const { pool } = db;

  async function findAll({ status = null, area = null } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (area) { where.push('nis2_area = ?'); params.push(area); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM blueeye_nis2_controls ${clause} ORDER BY nis2_area ASC, id DESC`,
      params
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM blueeye_nis2_controls WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  // Controls lacking evidence (no evidence_file) OR flagged Missing/Overdue —
  // the prioritised "needs attention" list on the dashboard. Missing/overdue and
  // the absence of evidence are the two ways a control fails its assurance.
  async function findWithoutEvidence() {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM blueeye_nis2_controls
       WHERE evidence_file IS NULL OR evidence_file = '' OR status IN ('Missing', 'Overdue')
       ORDER BY FIELD(status, 'Overdue', 'Missing', 'Partial', 'OK'), nis2_area ASC`
    );
    return rows.map(mapRow);
  }

  async function create(input) {
    const [res] = await pool.query(
      `INSERT INTO blueeye_nis2_controls
         (control_name, nis2_area, description, owner, frequency, last_performed,
          next_due, evidence_file, status, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.controlName, input.nis2Area, input.description ?? null, input.owner ?? null,
        input.frequency, input.lastPerformed ?? null, input.nextDue ?? null,
        input.evidenceFile ?? null, input.status, input.comment ?? null,
      ]
    );
    return findById(res.insertId);
  }

  async function update(id, input) {
    await pool.query(
      `UPDATE blueeye_nis2_controls SET
         control_name = ?, nis2_area = ?, description = ?, owner = ?, frequency = ?,
         last_performed = ?, next_due = ?, evidence_file = ?, status = ?, comment = ?
       WHERE id = ?`,
      [
        input.controlName, input.nis2Area, input.description ?? null, input.owner ?? null,
        input.frequency, input.lastPerformed ?? null, input.nextDue ?? null,
        input.evidenceFile ?? null, input.status, input.comment ?? null, id,
      ]
    );
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM blueeye_nis2_controls WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  return { findAll, findById, findWithoutEvidence, create, update, remove };
}

module.exports = { createNis2ControlsRepository, mapRow };
