'use strict';

// Data-access for `runbooks` (migration 061) — the static finding-type →
// recommended-action mapping. Pure data-access; matching/recommendation policy
// lives in the route + src/remediation/recommendedActions.js.
//
// A runbook maps a finding metric (e.g. 'cpu', 'probe.loss') to a markdown
// remediation, optionally linked to a remediation playbook. finding_type is NOT
// unique — several runbooks may target the same type and all are surfaced.

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    findingType: row.finding_type,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    linkedPlaybookId: row.linked_playbook_id == null ? null : Number(row.linked_playbook_id),
    updatedBy: row.updated_by == null ? null : Number(row.updated_by),
    updatedAt: toIso(row.updated_at),
    createdAt: toIso(row.created_at),
    // Joined from remediation_playbooks (LEFT JOIN) when present.
    linkedPlaybookName: row.linked_playbook_name ?? null,
  };
}

const COLS = 'id, finding_type, title, body_markdown, linked_playbook_id, updated_by, updated_at, created_at';
const JOINED = `r.id, r.finding_type, r.title, r.body_markdown, r.linked_playbook_id, r.updated_by,
  r.updated_at, r.created_at, p.name AS linked_playbook_name`;

function createRunbooksRepository(db) {
  const { pool } = db;

  async function list() {
    const [rows] = await pool.query(
      `SELECT ${JOINED} FROM runbooks r
       LEFT JOIN remediation_playbooks p ON p.id = r.linked_playbook_id
       ORDER BY r.finding_type ASC, r.id DESC`,
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${JOINED} FROM runbooks r
       LEFT JOIN remediation_playbooks p ON p.id = r.linked_playbook_id
       WHERE r.id = ?`,
      [id],
    );
    return mapRow(rows[0]) ?? null;
  }

  // All enabled runbooks whose finding_type is one of `types` (exact match),
  // joined with the linked playbook name. Empty/blank input → [].
  async function listByFindingTypes(types) {
    const list = [...new Set((Array.isArray(types) ? types : []).filter((t) => t != null && t !== ''))];
    if (list.length === 0) return [];
    const [rows] = await pool.query(
      `SELECT ${JOINED} FROM runbooks r
       LEFT JOIN remediation_playbooks p ON p.id = r.linked_playbook_id
       WHERE r.finding_type IN (${list.map(() => '?').join(', ')})
       ORDER BY r.finding_type ASC, r.id DESC`,
      list,
    );
    return rows.map(mapRow);
  }

  async function create({ findingType, title, bodyMarkdown, linkedPlaybookId = null, updatedBy = null }) {
    const [res] = await pool.query(
      `INSERT INTO runbooks (finding_type, title, body_markdown, linked_playbook_id, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
      [findingType, title, bodyMarkdown, linkedPlaybookId, updatedBy],
    );
    return Number(res.insertId);
  }

  async function update(id, { findingType, title, bodyMarkdown, linkedPlaybookId = null, updatedBy = null }) {
    const [res] = await pool.query(
      `UPDATE runbooks
          SET finding_type = ?, title = ?, body_markdown = ?, linked_playbook_id = ?, updated_by = ?
        WHERE id = ?`,
      [findingType, title, bodyMarkdown, linkedPlaybookId, updatedBy, id],
    );
    return res.affectedRows > 0;
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM runbooks WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  return { list, findById, listByFindingTypes, create, update, remove };
}

module.exports = { createRunbooksRepository, mapRow, COLS };
