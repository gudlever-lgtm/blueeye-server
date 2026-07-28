'use strict';

// Data-access for `incident_notes` (migration 072) — the incident work log that
// carries an investigation across shift handovers.
//
// APPEND-ONLY IS ENFORCED HERE, not just documented: this module exports insert
// + read functions and NOTHING else. There is no update(), no remove(), no
// upsert. A caller that wants to change history has no method to call, which is
// a stronger guarantee than a comment asking it not to.
//
// Reads are chronological (oldest-first): a work log is a narrative, and a
// handover reads forward. That is the opposite of the findings/audit lists,
// which are newest-first — deliberately so, and the reason it is spelled out
// here rather than left to look like an oversight.

const KINDS = ['observation', 'action', 'ruled_out'];

const BASE_COLUMNS = `id, incident_case_id, kind, text, author_user_id,
  author_email, author_role, created_at`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// Maps a DB row to the public API shape (camelCase, like the other repos).
// `author` collapses the denormalised snapshot into one display string so the
// UI never has to decide between email and id — and still shows something
// useful after the user row is gone (author_user_id goes NULL, email survives).
function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    incidentCaseId: Number(row.incident_case_id),
    kind: row.kind,
    text: row.text,
    authorUserId: row.author_user_id == null ? null : Number(row.author_user_id),
    authorEmail: row.author_email ?? null,
    authorRole: row.author_role ?? null,
    author: row.author_email || (row.author_user_id ? `user #${row.author_user_id}` : 'system'),
    createdAt: toIso(row.created_at),
  };
}

function createIncidentNotesRepository(db) {
  const { pool } = db;

  // Appends one note and returns it as stored (so the caller renders exactly
  // what was persisted — including the server-assigned timestamp — instead of
  // echoing back its own request body).
  async function append({
    incidentCaseId,
    kind,
    text,
    authorUserId = null,
    authorEmail = null,
    authorRole = null,
  }) {
    const [res] = await pool.query(
      `INSERT INTO incident_notes
         (incident_case_id, kind, text, author_user_id, author_email, author_role)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [incidentCaseId, kind, text, authorUserId, authorEmail, authorRole]
    );
    const id = Number(res.insertId);
    return findById(id);
  }

  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_notes WHERE id = ?`,
      [id]
    );
    return mapRow(rows[0]);
  }

  // The full log for one incident, oldest-first. `limit` is a safety cap, not a
  // pagination scheme — a work log that needs paging is already a process
  // problem, and truncating the MIDDLE of a narrative would be worse than
  // capping it, so this keeps the OLDEST entries and the route reports the
  // total so the UI can say what it is not showing.
  async function listForIncident({ incidentCaseId, limit = 500 }) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_notes
        WHERE incident_case_id = ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
      [incidentCaseId, limit]
    );
    return rows.map(mapRow);
  }

  // Only the ruled_out entries, oldest-first. Separate from listForIncident so
  // the "this is excluded" panel is one indexed query rather than a client-side
  // filter over a log that may be capped — the exclusions must never be the
  // rows that fall off the end.
  async function listRuledOut({ incidentCaseId, limit = 200 }) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM incident_notes
        WHERE incident_case_id = ? AND kind = 'ruled_out'
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
      [incidentCaseId, limit]
    );
    return rows.map(mapRow);
  }

  async function countForIncident({ incidentCaseId }) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM incident_notes WHERE incident_case_id = ?',
      [incidentCaseId]
    );
    return Number(rows[0] ? rows[0].n : 0);
  }

  return { append, findById, listForIncident, listRuledOut, countForIncident };
}

module.exports = { createIncidentNotesRepository, KINDS };
