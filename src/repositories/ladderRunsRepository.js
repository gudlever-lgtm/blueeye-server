'use strict';

// Data access for `ladder_runs` (migration 141) — the log of diagnoses run.
//
// One row per walk of the Connection test's ladder. The row is written when the
// probes are DISPATCHED, and its verdict is stamped on later, when the ladder is
// next read: the probes come back over the following seconds, so the conclusion
// does not exist at the moment the button is pressed.
//
// Each later read overwrites the verdict. Last write wins, which is the final
// state of that diagnosis rather than its first, most-incomplete one.

const MAX_SYMPTOM = 500;
const MAX_TARGET = 255;

// How long after a walk a verdict may still be attributed to it. A read of the
// same destination the next morning is a new question about an old run, not the
// conclusion of that run — stamping it on would rewrite yesterday's diagnosis
// with today's network.
const VERDICT_WINDOW_MS = 30 * 60 * 1000;

const clip = (v, max) => (v == null ? null : String(v).slice(0, max));

function fromRow(row) {
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    peerAgentId: row.peer_agent_id == null ? null : Number(row.peer_agent_id),
    ladder: row.ladder,
    target: row.target ?? null,
    symptom: row.symptom ?? null,
    outcome: row.outcome ?? null,
    stopsAt: row.stops_at ?? null,
    dispatched: Number(row.dispatched || 0),
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    verdictAt: row.verdict_at == null ? null : (row.verdict_at instanceof Date ? row.verdict_at.toISOString() : row.verdict_at),
    startedBy: row.started_by == null ? null : Number(row.started_by),
    startedEmail: row.started_email ?? null,
  };
}

function createLadderRunsRepository(db) {
  const { pool } = db;

  // Records a walk at the moment it is dispatched. Returns the new row's id, so
  // the caller can hand it back and a verdict can find its run without guessing.
  async function start({
    agentId, peerAgentId = null, ladder, target = null, symptom = null,
    dispatched = 0, startedBy = null, startedEmail = null, at = new Date(),
  }) {
    const [res] = await pool.query(
      `INSERT INTO ladder_runs
         (agent_id, peer_agent_id, ladder, target, symptom, dispatched, started_at, started_by, started_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId, peerAgentId, String(ladder).slice(0, 32), clip(target, MAX_TARGET), clip(symptom, MAX_SYMPTOM),
        Number.isInteger(dispatched) ? dispatched : 0, at, startedBy, clip(startedEmail, 255),
      ]
    );
    return Number(res.insertId);
  }

  // Stamps the verdict onto the most recent run of this (agent, ladder, target)
  // that is still inside the window. Returns the id it wrote to, or null when
  // there was no run to attribute it to — a read with no walk behind it is
  // somebody looking at history, and inventing a run for it would log a
  // diagnosis nobody performed.
  async function recordVerdict({ agentId, ladder, target = null, outcome = null, stopsAt = null, at = new Date() }) {
    const since = new Date(at.getTime() - VERDICT_WINDOW_MS);
    const [rows] = await pool.query(
      `SELECT id FROM ladder_runs
        WHERE agent_id = ? AND ladder = ? AND ${target == null ? 'target IS NULL' : 'target = ?'}
          AND started_at >= ?
        ORDER BY started_at DESC, id DESC LIMIT 1`,
      target == null ? [agentId, String(ladder), since] : [agentId, String(ladder), clip(target, MAX_TARGET), since]
    );
    if (!rows.length) return null;
    const id = Number(rows[0].id);
    await pool.query(
      'UPDATE ladder_runs SET outcome = ?, stops_at = ?, verdict_at = ? WHERE id = ?',
      [clip(outcome, 16), clip(stopsAt, 32), at, id]
    );
    return id;
  }

  // The diagnoses run, newest first. Filterable by agent and by ladder, because
  // "what did we last diagnose about this host" and "every two-way walk we have
  // done" are both questions somebody asks.
  async function list({ agentId = null, ladder = null, target = null, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    if (ladder) { where.push('ladder = ?'); params.push(String(ladder)); }
    if (target) { where.push('target = ?'); params.push(clip(target, MAX_TARGET)); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
    const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const [rows] = await pool.query(
      `SELECT * FROM ladder_runs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, lim, off]
    );
    return rows.map(fromRow);
  }

  async function findById(id) {
    const [rows] = await pool.query('SELECT * FROM ladder_runs WHERE id = ? LIMIT 1', [id]);
    return rows.length ? fromRow(rows[0]) : null;
  }

  // Retention: the diagnoses are a log, and a log that grows for ever is a
  // disk-space incident waiting to happen.
  async function purgeBefore(cutoff) {
    const [res] = await pool.query('DELETE FROM ladder_runs WHERE started_at < ?', [cutoff]);
    return res.affectedRows;
  }

  return { start, recordVerdict, list, findById, purgeBefore };
}

module.exports = { createLadderRunsRepository, VERDICT_WINDOW_MS, fromRow };
