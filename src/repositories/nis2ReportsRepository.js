'use strict';

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
const toDate = (v) => (v ? String(v).slice(0, 10) : null);

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    reportType: row.report_type,
    title: row.title,
    periodStart: toDate(row.period_start),
    periodEnd: toDate(row.period_end),
    status: row.status,
    summary: row.summary ?? null,
    snapshot: parseJson(row.snapshot_json),
    generatedBy: row.generated_by == null ? null : Number(row.generated_by),
    generatedByEmail: row.generated_by_email ?? null,
    approvedBy: row.approved_by == null ? null : Number(row.approved_by),
    approvedByEmail: row.approved_by_email ?? null,
    approvedAt: toIso(row.approved_at),
    createdAt: toIso(row.created_at),
  };
}

const COLS = `id, report_type, title, period_start, period_end, status, summary,
  snapshot_json, generated_by, generated_by_email, approved_by, approved_by_email,
  approved_at, created_at`;

// Data-access for `blueeye_nis2_reports` — generated/approved management reports
// with a frozen metrics snapshot for trend comparison.
function createNis2ReportsRepository(db) {
  const { pool } = db;

  async function findAll({ type = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (type) { where.push('report_type = ?'); params.push(type); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 100;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM blueeye_nis2_reports ${clause} ORDER BY id DESC LIMIT ?`,
      params
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM blueeye_nis2_reports WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  // The most recent report of a type — used to compute the delta on the next one.
  async function findLatest(type) {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM blueeye_nis2_reports WHERE report_type = ? ORDER BY id DESC LIMIT 1`,
      [type]
    );
    return mapRow(rows[0]) ?? null;
  }

  async function create(input) {
    const [res] = await pool.query(
      `INSERT INTO blueeye_nis2_reports
         (report_type, title, period_start, period_end, status, summary, snapshot_json,
          generated_by, generated_by_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.reportType, input.title, input.periodStart ?? null, input.periodEnd ?? null,
        input.status || 'draft', input.summary ?? null,
        input.snapshot == null ? null : JSON.stringify(input.snapshot),
        input.generatedBy ?? null, input.generatedByEmail ?? null,
      ]
    );
    return findById(res.insertId);
  }

  // Marks a draft report approved (idempotent: only flips a draft). Returns the
  // updated report, or null if it didn't exist / wasn't a draft.
  async function approve(id, { approvedBy, approvedByEmail }) {
    const [res] = await pool.query(
      `UPDATE blueeye_nis2_reports
         SET status = 'approved', approved_by = ?, approved_by_email = ?, approved_at = NOW()
       WHERE id = ? AND status = 'draft'`,
      [approvedBy ?? null, approvedByEmail ?? null, id]
    );
    if (res.affectedRows === 0) return null;
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM blueeye_nis2_reports WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  return { findAll, findById, findLatest, create, approve, remove };
}

module.exports = { createNis2ReportsRepository, mapRow };
