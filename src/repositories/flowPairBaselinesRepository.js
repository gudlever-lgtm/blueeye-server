'use strict';

// Data-access for flow_pair_hourly (append-only hourly volume rollup) and
// flow_pair_baselines (per (pair, dow, hour) median+MAD). Migration 068. Pure
// data-access; the rollup/baseline/scoring logic lives in
// src/analysis/flowPairBaseline.js + src/analysis/flowPairBaselineJob.js.

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function mapHourly(r) {
  return {
    srcHostId: Number(r.src_host_id), dstHostId: Number(r.dst_host_id), dstPort: Number(r.dst_port),
    proto: r.proto ?? 'tcp', bucket: toIso(r.bucket), bytes: num(r.bytes), packets: num(r.packets), connCount: num(r.conn_count),
  };
}
function mapBaseline(r) {
  return {
    srcHostId: Number(r.src_host_id), dstHostId: Number(r.dst_host_id), dstPort: Number(r.dst_port),
    dow: Number(r.dow), hour: Number(r.hour), medianBytes: num(r.median_bytes), madBytes: num(r.mad_bytes),
    sampleCount: num(r.sample_count), observationCount: num(r.observation_count), updatedAt: toIso(r.updated_at),
  };
}

function createFlowPairBaselinesRepository(db) {
  const { pool } = db;

  // Append one hour's per-tuple volume. Idempotent per (bucket, tuple) so a
  // re-run of the same hour overwrites rather than duplicates.
  async function insertHourly(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.srcHostId != null && r.dstHostId != null && r.dstPort != null);
    if (!list.length) return 0;
    const values = list.map((r) => [r.bucket, r.srcHostId, r.dstHostId, r.dstPort, r.proto || 'tcp', r.bytes || 0, r.packets || 0, r.connCount || 0]);
    const [res] = await pool.query(
      `INSERT INTO flow_pair_hourly (bucket, src_host_id, dst_host_id, dst_port, proto, bytes, packets, conn_count)
       VALUES ?
       ON DUPLICATE KEY UPDATE bytes = VALUES(bytes), packets = VALUES(packets), conn_count = VALUES(conn_count)`,
      [values],
    );
    return res.affectedRows || 0;
  }

  async function purgeHourlyBefore(cutoff) {
    const [res] = await pool.query('DELETE FROM flow_pair_hourly WHERE bucket < ?', [cutoff]);
    return res.affectedRows || 0;
  }

  // All hourly rows in [since, now] — the baseline-recompute input. Bounded.
  async function hourlySince({ since, limit = 2000000 }) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000000 ? limit : 2000000;
    const [rows] = await pool.query(
      `SELECT src_host_id, dst_host_id, dst_port, proto, bucket, bytes, packets, conn_count
       FROM flow_pair_hourly WHERE bucket >= ? ORDER BY id ASC LIMIT ?`,
      [since, lim],
    );
    return rows.map(mapHourly);
  }

  // The rows for one exact hour bucket — the set to score after a rollup.
  async function rowsForBucket(bucket) {
    const [rows] = await pool.query(
      `SELECT src_host_id, dst_host_id, dst_port, proto, bucket, bytes, packets, conn_count
       FROM flow_pair_hourly WHERE bucket = ?`,
      [bucket],
    );
    return rows.map(mapHourly);
  }

  // Replace the baseline set (upsert each computed row). Stale rows that no
  // longer qualify simply age via updated_at; a full recompute overwrites all
  // currently-eligible slots.
  async function upsertBaselines(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.srcHostId != null);
    if (!list.length) return 0;
    const values = list.map((r) => [r.srcHostId, r.dstHostId, r.dstPort, r.dow, r.hour, r.medianBytes || 0, r.madBytes || 0, r.sampleCount || 0, r.observationCount || 0]);
    const [res] = await pool.query(
      `INSERT INTO flow_pair_baselines (src_host_id, dst_host_id, dst_port, dow, hour, median_bytes, mad_bytes, sample_count, observation_count)
       VALUES ?
       ON DUPLICATE KEY UPDATE median_bytes = VALUES(median_bytes), mad_bytes = VALUES(mad_bytes), sample_count = VALUES(sample_count), observation_count = VALUES(observation_count)`,
      [values],
    );
    return res.affectedRows || 0;
  }

  // All baselines for one (dow, hour) slot — build a lookup map to score the
  // current hour's tuples in one query.
  async function baselinesForSlot({ dow, hour }) {
    const [rows] = await pool.query(
      'SELECT * FROM flow_pair_baselines WHERE dow = ? AND hour = ?',
      [dow, hour],
    );
    return rows.map(mapBaseline);
  }

  // Baselines where the host is the source (its outbound flow-pair profile).
  async function listForHost({ hostId, limit = 500 }) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    const [rows] = await pool.query(
      `SELECT * FROM flow_pair_baselines WHERE src_host_id = ?
       ORDER BY dst_host_id, dst_port, dow, hour LIMIT ?`,
      [hostId, lim],
    );
    return rows.map(mapBaseline);
  }

  async function countForHost({ hostId }) {
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM flow_pair_baselines WHERE src_host_id = ?', [hostId]);
    return rows && rows[0] ? Number(rows[0].n) : 0;
  }

  return { insertHourly, purgeHourlyBefore, hourlySince, rowsForBucket, upsertBaselines, baselinesForSlot, listForHost, countForHost };
}

module.exports = { createFlowPairBaselinesRepository, mapHourly, mapBaseline };
