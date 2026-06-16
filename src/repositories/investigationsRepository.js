'use strict';

const crypto = require('crypto');

const COLUMNS =
  'id, location_ref, window_from, window_to, classification, confidence, ' +
  'explanation, evidence, suspected_segment, related_finding_ids, workaround_hints, ' +
  'narrative, created_at';

const MAX_LIST = 200;

function parseJson(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return v;
}

function mapRow(row) {
  return {
    id: row.id,
    locationRef: parseJson(row.location_ref, {}),
    window: { from: row.window_from, to: row.window_to },
    classification: row.classification,
    confidence: Number(row.confidence),
    explanation: row.explanation,
    evidence: parseJson(row.evidence, []),
    suspectedSegment: parseJson(row.suspected_segment, null),
    relatedFindingIds: parseJson(row.related_finding_ids, []),
    workaroundHints: parseJson(row.workaround_hints, []),
    narrative: row.narrative || null,
    createdAt: row.created_at,
  };
}

function createInvestigationsRepository(db) {
  const { pool } = db;

  async function save(inv) {
    if (!inv || typeof inv !== 'object') throw new Error('save requires an investigation object');
    if (typeof inv.explanation !== 'string' || inv.explanation.trim() === '') {
      throw new Error('investigation.explanation must be a non-empty string');
    }
    if (!Array.isArray(inv.evidence) || inv.evidence.length < 1) {
      throw new Error('investigation.evidence must contain at least one entry');
    }

    const id = inv.id || crypto.randomUUID();
    await pool.query(
      `INSERT INTO investigations
         (id, location_ref, window_from, window_to, classification, confidence,
          explanation, evidence, suspected_segment, related_finding_ids,
          workaround_hints, narrative)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        JSON.stringify(inv.locationRef),
        inv.window.from,
        inv.window.to,
        inv.classification,
        Number.isFinite(inv.confidence) ? inv.confidence : 0,
        inv.explanation,
        JSON.stringify(inv.evidence),
        JSON.stringify(inv.suspectedSegment || null),
        JSON.stringify(Array.isArray(inv.relatedFindingIds) ? inv.relatedFindingIds : []),
        JSON.stringify(Array.isArray(inv.workaroundHints) ? inv.workaroundHints : []),
        typeof inv.narrative === 'string' ? inv.narrative : null,
      ]
    );
    return { ...inv, id };
  }

  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${COLUMNS} FROM investigations WHERE id = ?`, [id]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async function list({ limit = 50, offset = 0 } = {}) {
    const n = Math.min(Number.isInteger(limit) && limit > 0 ? limit : 50, MAX_LIST);
    const o = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const [rows] = await pool.query(
      `SELECT ${COLUMNS} FROM investigations ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [n, o]
    );
    return rows.map(mapRow);
  }

  return { save, findById, list };
}

module.exports = { createInvestigationsRepository };
