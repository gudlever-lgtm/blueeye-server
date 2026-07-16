'use strict';

const zlib = require('zlib');

// Data-access for `cluster_evidence_snapshots` (migration 065). Evidence is a
// compressed blob per (cluster, target); this repo gzips on write and gunzips on
// read so callers deal in plain text. Pure data-access; the capture policy lives
// in src/evidence/snapshotService.js.

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function parseJson(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (value == null) return fallback;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return fallback; } }
  return fallback;
}

// Row → metadata object (never includes the blob; use getPayload for that).
function mapMeta(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    clusterId: Number(row.cluster_id),
    target: row.target,
    commandSetVersion: row.command_set_version,
    status: row.status,
    items: parseJson(row.items, []),
    payloadBytes: Number(row.payload_bytes || 0),
    capturedAt: toIso(row.captured_at),
    trigger: row.trigger,
    createdAt: toIso(row.created_at),
  };
}

const META_COLS = 'id, cluster_id, target, command_set_version, status, items, payload_bytes, captured_at, trigger, created_at';

function createEvidenceSnapshotsRepository(db) {
  const { pool } = db;

  // Opens a pending snapshot for (cluster, target). Returns the new id.
  async function create({ clusterId, target, commandSetVersion, capturedAt, trigger = 'auto' }) {
    const [res] = await pool.query(
      `INSERT INTO cluster_evidence_snapshots
         (cluster_id, target, command_set_version, status, items, captured_at, trigger)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [clusterId, String(target), commandSetVersion, JSON.stringify([]), capturedAt, trigger],
    );
    return Number(res.insertId);
  }

  // Finalises a snapshot: gzip the payload text, store per-command items + status.
  async function complete(id, { status, items = [], payloadText = null }) {
    const gz = payloadText != null ? zlib.gzipSync(Buffer.from(String(payloadText), 'utf8')) : null;
    const bytes = payloadText != null ? Buffer.byteLength(String(payloadText), 'utf8') : 0;
    const [res] = await pool.query(
      `UPDATE cluster_evidence_snapshots
          SET status = ?, items = ?, payload_gzip = ?, payload_bytes = ?
        WHERE id = ?`,
      [status, JSON.stringify(items || []), gz, bytes, id],
    );
    return res.affectedRows > 0;
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${META_COLS} FROM cluster_evidence_snapshots WHERE id = ?`, [id]);
    return mapMeta(rows[0]) ?? null;
  }

  // Snapshots for a cluster, newest first (metadata only).
  async function listForCluster(clusterId, { limit = 200 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 2000 ? limit : 200;
    const [rows] = await pool.query(
      `SELECT ${META_COLS} FROM cluster_evidence_snapshots
       WHERE cluster_id = ? ORDER BY captured_at DESC, id DESC LIMIT ?`,
      [clusterId, lim],
    );
    return rows.map(mapMeta);
  }

  // The decompressed raw-text payload for the viewer, or null.
  async function getPayload(id) {
    const [rows] = await pool.query('SELECT payload_gzip FROM cluster_evidence_snapshots WHERE id = ?', [id]);
    if (!rows[0]) return null;
    const gz = rows[0].payload_gzip;
    if (gz == null) return '';
    try { return zlib.gunzipSync(gz).toString('utf8'); } catch { return ''; }
  }

  // Retention age-out: deletes snapshots older than `olderThan` EXCEPT those whose
  // cluster still has an unacknowledged CRIT finding (the never-delete rule). The
  // protected cluster-id set is computed by the caller (it knows the finding store)
  // and passed as `protectedClusterIds`. Returns the number deleted.
  async function ageOut(olderThan, { protectedClusterIds = [] } = {}) {
    const params = [olderThan];
    let clause = 'captured_at < ?';
    const ids = [...new Set((protectedClusterIds || []).map((x) => Number(x)).filter(Number.isFinite))];
    if (ids.length) {
      clause += ` AND cluster_id NOT IN (${ids.map(() => '?').join(', ')})`;
      params.push(...ids);
    }
    const [res] = await pool.query(`DELETE FROM cluster_evidence_snapshots WHERE ${clause}`, params);
    return res.affectedRows || 0;
  }

  // Distinct cluster ids with a snapshot older than `olderThan` — the age-out
  // candidates the caller filters by the CRIT rule before deleting.
  async function clusterIdsWithSnapshotsOlderThan(olderThan, { limit = 5000 } = {}) {
    const [rows] = await pool.query(
      'SELECT DISTINCT cluster_id FROM cluster_evidence_snapshots WHERE captured_at < ? LIMIT ?',
      [olderThan, limit],
    );
    return rows.map((r) => Number(r.cluster_id));
  }

  return { create, complete, findById, listForCluster, getPayload, ageOut, clusterIdsWithSnapshotsOlderThan };
}

module.exports = { createEvidenceSnapshotsRepository, mapMeta };
