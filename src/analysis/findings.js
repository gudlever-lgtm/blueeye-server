'use strict';

const crypto = require('crypto');
const { Severity, FindingKind } = require('./constants');

// Columns selected when reading findings back.
const COLUMNS =
  'id, host_id, metric, severity, kind, observed, baseline, deviation, ' +
  'window_from, window_to, explanation, evidence, correlated_with, acked, created_at';

// Hard ceiling on how many findings a single list() call can return.
const MAX_LIST = 5000;

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

// Re-hydrate stored sample timestamps (stored as ISO strings inside the JSON).
function reviveEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.map((s) => ({ ...s, ts: s && s.ts ? new Date(s.ts) : s.ts }));
}

// Maps a DB row to the public Finding shape.
function mapRow(row) {
  return {
    id: row.id,
    hostId: row.host_id,
    metric: row.metric,
    severity: row.severity,
    kind: row.kind,
    observed: row.observed,
    baseline: row.baseline,
    deviation: row.deviation,
    window: [row.window_from, row.window_to],
    explanation: row.explanation,
    evidence: reviveEvidence(parseJson(row.evidence, [])),
    correlatedWith: parseJson(row.correlated_with, []) || [],
    createdAt: row.created_at,
    acked: row.acked === 1 || row.acked === true,
  };
}

// Persists and reads analysis findings, reusing the server's existing DB handle
// (db.pool) — it does NOT open a new connection. Construct with the same `db`
// object the rest of the server uses: new FindingStore({ db }).
class FindingStore {
  constructor({ db }) {
    if (!db || !db.pool) {
      throw new Error('FindingStore requires the server db handle ({ db: { pool } })');
    }
    this.pool = db.pool;
  }

  // Validates and persists a finding. A finding MUST carry a non-empty
  // explanation and at least one evidence sample, otherwise this throws.
  // Returns the stored finding (with id/createdAt filled in if absent).
  async save(finding) {
    if (!finding || typeof finding !== 'object') {
      throw new Error('save requires a finding object');
    }
    if (typeof finding.explanation !== 'string' || finding.explanation.trim() === '') {
      throw new Error('finding.explanation must be a non-empty string');
    }
    if (!Array.isArray(finding.evidence) || finding.evidence.length < 1) {
      throw new Error('finding.evidence must contain at least one sample');
    }

    const id = finding.id || crypto.randomUUID();
    const createdAt = finding.createdAt instanceof Date ? finding.createdAt : new Date();
    const win = Array.isArray(finding.window) ? finding.window : [null, null];

    await this.pool.query(
      `INSERT INTO findings
         (id, host_id, metric, severity, kind, observed, baseline, deviation,
          window_from, window_to, explanation, evidence, correlated_with, acked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        finding.hostId,
        finding.metric,
        finding.severity || Severity.INFO,
        finding.kind || FindingKind.ANOMALY,
        finding.observed ?? null,
        finding.baseline ?? null,
        finding.deviation ?? null,
        win[0] ?? null,
        win[1] ?? null,
        finding.explanation,
        JSON.stringify(finding.evidence),
        JSON.stringify(finding.correlatedWith || []),
        finding.acked ? 1 : 0,
        createdAt,
      ]
    );

    return { ...finding, id, createdAt, acked: Boolean(finding.acked) };
  }

  // Lists findings, newest first. Optionally filters by hostId and/or a `since`
  // lower bound on created_at (Date or ISO string). `limit` is always bounded so
  // an unfiltered call can never return the whole table; it defaults to (and is
  // capped at) MAX_LIST.
  async list(hostId, since, limit) {
    const where = [];
    const params = [];
    if (hostId) {
      where.push('host_id = ?');
      params.push(hostId);
    }
    if (since) {
      where.push('created_at >= ?');
      params.push(since instanceof Date ? since : new Date(since));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIST) : MAX_LIST;
    params.push(n);
    const [rows] = await this.pool.query(
      `SELECT ${COLUMNS} FROM findings ${clause} ORDER BY created_at DESC, id LIMIT ?`,
      params
    );
    return rows.map(mapRow);
  }

  // Fetches one finding by id, or null.
  async get(id) {
    const [rows] = await this.pool.query(`SELECT ${COLUMNS} FROM findings WHERE id = ?`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  // Marks a finding acknowledged. Returns true if a row was updated, false if
  // no finding has that id.
  async ack(id) {
    const [result] = await this.pool.query('UPDATE findings SET acked = 1 WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  // Persists the correlation links for a finding (the ids of the other findings
  // the correlator grouped it with). Stored as JSON. Returns true if a row was
  // updated, false if no finding has that id.
  async setCorrelations(id, correlatedIds) {
    const ids = Array.isArray(correlatedIds) ? correlatedIds : [];
    const [result] = await this.pool.query(
      'UPDATE findings SET correlated_with = ? WHERE id = ?',
      [JSON.stringify(ids), id]
    );
    return result.affectedRows > 0;
  }
}

module.exports = { FindingStore };
