'use strict';

const { riskBand } = require('../nis2/constants');

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// Maps a DB row to the API shape (camelCase + a derived colour band). Dates that
// are date-only columns (due_date) are returned as YYYY-MM-DD strings as MySQL
// gives them; timestamps are ISO.
function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description ?? null,
    category: row.category,
    affectedAsset: row.affected_asset ?? null,
    likelihood: Number(row.likelihood),
    impact: Number(row.impact),
    riskScore: Number(row.risk_score),
    band: riskBand(row.risk_score),
    owner: row.owner ?? null,
    status: row.status,
    mitigationPlan: row.mitigation_plan ?? null,
    dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
    managementAcceptance: !!row.management_acceptance,
    evidenceLink: row.evidence_link ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const COLS = `id, title, description, category, affected_asset, likelihood, impact,
  risk_score, owner, status, mitigation_plan, due_date, management_acceptance,
  evidence_link, created_at, updated_at`;

// Data-access for `blueeye_nis2_risks`. risk_score is always computed here from
// likelihood * impact, so the stored value can never drift from its inputs.
function createNis2RisksRepository(db) {
  const { pool } = db;

  // Lists risks, newest-first, with optional status/category filters.
  async function findAll({ status = null, category = null } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (category) { where.push('category = ?'); params.push(category); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM blueeye_nis2_risks ${clause} ORDER BY risk_score DESC, id DESC`,
      params
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM blueeye_nis2_risks WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  async function create(input) {
    const score = Number(input.likelihood) * Number(input.impact);
    const [res] = await pool.query(
      `INSERT INTO blueeye_nis2_risks
         (title, description, category, affected_asset, likelihood, impact, risk_score,
          owner, status, mitigation_plan, due_date, management_acceptance, evidence_link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.title, input.description ?? null, input.category, input.affectedAsset ?? null,
        input.likelihood, input.impact, score, input.owner ?? null, input.status,
        input.mitigationPlan ?? null, input.dueDate ?? null,
        input.managementAcceptance ? 1 : 0, input.evidenceLink ?? null,
      ]
    );
    return findById(res.insertId);
  }

  async function update(id, input) {
    const score = Number(input.likelihood) * Number(input.impact);
    await pool.query(
      `UPDATE blueeye_nis2_risks SET
         title = ?, description = ?, category = ?, affected_asset = ?, likelihood = ?,
         impact = ?, risk_score = ?, owner = ?, status = ?, mitigation_plan = ?,
         due_date = ?, management_acceptance = ?, evidence_link = ?
       WHERE id = ?`,
      [
        input.title, input.description ?? null, input.category, input.affectedAsset ?? null,
        input.likelihood, input.impact, score, input.owner ?? null, input.status,
        input.mitigationPlan ?? null, input.dueDate ?? null,
        input.managementAcceptance ? 1 : 0, input.evidenceLink ?? null, id,
      ]
    );
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM blueeye_nis2_risks WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  return { findAll, findById, create, update, remove };
}

module.exports = { createNis2RisksRepository, mapRow };
