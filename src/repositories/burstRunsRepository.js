'use strict';

// Data-access for `burst_runs` (migration 107).
//
// A burst is written TWICE: once when it starts (so the screen can show a live
// run and a run whose agent went away is still visible), and once when the
// samples arrive. Nothing is written per sample — the whole series is one
// bounded JSON field, for the reasons in the migration.

const BASE_COLUMNS = `id, agent_id, target, probe, requested_seconds, seconds, hz,
  started_at, ended_at, status, error, sample_count, lost_count, loss_pct,
  median_rtt_ms, p95_rtt_ms, jitter_ms, loss_clusters, pattern, explanation,
  created_by, created_at`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapRow(row, { withSamples = false } = {}) {
  if (!row) return null;
  const out = {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    target: row.target,
    probe: row.probe,
    requestedSeconds: row.requested_seconds == null ? null : Number(row.requested_seconds),
    seconds: Number(row.seconds),
    hz: num(row.hz),
    startedAt: toIso(row.started_at),
    endedAt: toIso(row.ended_at),
    status: row.status,
    error: row.error ?? null,
    sampleCount: Number(row.sample_count),
    lostCount: Number(row.lost_count),
    lossPct: num(row.loss_pct),
    medianRttMs: num(row.median_rtt_ms),
    p95RttMs: num(row.p95_rtt_ms),
    jitterMs: num(row.jitter_ms),
    lossClusters: row.loss_clusters == null ? null : Number(row.loss_clusters),
    pattern: row.pattern ?? null,
    // The sentence. The only part of this row worth anything on its own.
    explanation: row.explanation ?? null,
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdAt: toIso(row.created_at),
  };
  // The series is omitted from list reads: 240 points per row would make a
  // page of twenty runs an order of magnitude larger for data nobody plots
  // until they open one.
  if (withSamples) {
    let samples = row.samples;
    if (typeof samples === 'string') {
      try { samples = JSON.parse(samples); } catch { samples = null; }
    }
    out.samples = Array.isArray(samples) ? samples : [];
  }
  return out;
}

function createBurstRunsRepository(db) {
  const { pool } = db;

  // Records a burst as it is dispatched, so the screen has a row to follow and
  // a run whose agent never answers is visible as `running` rather than absent.
  async function start({ agentId, target, probe = 'ping', requestedSeconds = null, seconds, hz = 1, createdBy = null, at = new Date() }) {
    const [res] = await pool.query(
      `INSERT INTO burst_runs
         (agent_id, target, probe, requested_seconds, seconds, hz, started_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      [agentId, target, probe, requestedSeconds, seconds, hz, at, createdBy],
    );
    return findById(res.insertId);
  }

  // Stores the finished series and its verdict.
  async function complete(id, { samples, analysis, status = 'complete', endedAt = new Date(), error = null }) {
    await pool.query(
      `UPDATE burst_runs
          SET status = ?, ended_at = ?, error = ?, samples = ?,
              sample_count = ?, lost_count = ?, loss_pct = ?, median_rtt_ms = ?,
              p95_rtt_ms = ?, jitter_ms = ?, loss_clusters = ?, pattern = ?, explanation = ?
        WHERE id = ?`,
      [
        status, endedAt, error == null ? null : String(error).slice(0, 255),
        samples == null ? null : JSON.stringify(samples),
        analysis ? analysis.sampleCount : 0,
        analysis ? analysis.lostCount : 0,
        analysis ? analysis.lossPct : null,
        analysis ? analysis.medianRttMs : null,
        analysis ? analysis.p95RttMs : null,
        analysis ? analysis.jitterMs : null,
        analysis ? analysis.lossClusters : null,
        analysis ? analysis.pattern : null,
        analysis ? String(analysis.explanation || '').slice(0, 512) : null,
        id,
      ],
    );
    return findById(id, { withSamples: true });
  }

  async function findById(id, { withSamples = false } = {}) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS}${withSamples ? ', samples' : ''} FROM burst_runs WHERE id = ? LIMIT 1`,
      [id],
    );
    return mapRow(rows[0], { withSamples });
  }

  async function list({ agentId = null, limit = 25, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM burst_runs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY started_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map((r) => mapRow(r));
  }

  // A run whose agent went away never gets its samples. Left `running` forever
  // it would look live; this reconciles the ones that cannot still be going.
  async function expireStale(olderThan) {
    const [res] = await pool.query(
      `UPDATE burst_runs
          SET status = 'failed', error = 'the agent never reported the result', ended_at = NOW(3)
        WHERE status = 'running' AND started_at < ?`,
      [olderThan],
    );
    return Number(res.affectedRows || 0);
  }

  async function purgeBefore(cutoff, { batchSize = 1000 } = {}) {
    let removed = 0;
    for (;;) {
      const [res] = await pool.query(
        'DELETE FROM burst_runs WHERE started_at < ? ORDER BY started_at LIMIT ?',
        [cutoff, batchSize],
      );
      const n = Number(res.affectedRows || 0);
      removed += n;
      if (n < batchSize) break;
    }
    return removed;
  }

  return { start, complete, findById, list, expireStale, purgeBefore };
}

module.exports = { createBurstRunsRepository, mapRow };
