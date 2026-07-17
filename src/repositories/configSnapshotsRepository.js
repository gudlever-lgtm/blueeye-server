'use strict';

// Data-access for `config_snapshots` — raw device-config captures (migration
// 049). Pure data-access: diff-generation lives in src/config/diff.js, and the
// risk classification + incident correlation + endpoints build on top of this.
//
// A "device" is an agent (device_id → agents.id), consistent with how findings /
// incidents key on the agent. config_text is raw and may contain secrets, so
// callers gate reads to operator/admin and mask at the API layer.

const META_COLUMNS = 'id, device_id, captured_at, captured_via, created_at';
const FULL_COLUMNS = `${META_COLUMNS}, config_text`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// Maps a row to the API shape. config_text is only present when it was selected
// (list-metadata omits it to keep history responses light).
function mapRow(row) {
  if (!row) return null;
  const out = {
    id: Number(row.id),
    deviceId: Number(row.device_id),
    capturedAt: toIso(row.captured_at),
    capturedVia: row.captured_via,
    createdAt: toIso(row.created_at),
  };
  if (Object.prototype.hasOwnProperty.call(row, 'config_text')) out.configText = row.config_text;
  return out;
}

function createConfigSnapshotsRepository(db) {
  const { pool } = db;

  // Inserts a snapshot and returns its new id. captured_at defaults to now in SQL
  // when not supplied.
  async function insert({ deviceId, configText, capturedVia = 'manual', capturedAt = null }) {
    if (capturedAt == null) {
      const [res] = await pool.query(
        `INSERT INTO config_snapshots (device_id, config_text, captured_via)
         VALUES (?, ?, ?)`,
        [deviceId, configText, capturedVia]
      );
      return Number(res.insertId);
    }
    const [res] = await pool.query(
      `INSERT INTO config_snapshots (device_id, config_text, captured_via, captured_at)
       VALUES (?, ?, ?, ?)`,
      [deviceId, configText, capturedVia, capturedAt]
    );
    return Number(res.insertId);
  }

  // One snapshot by id, including its raw config_text.
  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${FULL_COLUMNS} FROM config_snapshots WHERE id = ?`,
      [id]
    );
    return mapRow(rows[0]) ?? null;
  }

  // Snapshots for a device, newest-first. `withText` includes the raw config_text
  // (heavier); the history endpoint uses metadata-only for the list and fetches
  // text per diff. Bounded.
  async function listForDevice(deviceId, { limit = 50, withText = false } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 50;
    const [rows] = await pool.query(
      `SELECT ${withText ? FULL_COLUMNS : META_COLUMNS} FROM config_snapshots
       WHERE device_id = ? ORDER BY captured_at DESC, id DESC LIMIT ?`,
      [deviceId, lim]
    );
    return rows.map(mapRow);
  }

  // The most recent snapshot for a device captured within (from, to] — used by
  // the anomaly↔config correlation to find a config change shortly BEFORE an
  // anomaly. Includes config_text so the caller can diff/classify it.
  async function latestForDeviceBetween(deviceId, from, to) {
    const [rows] = await pool.query(
      `SELECT ${FULL_COLUMNS} FROM config_snapshots
       WHERE device_id = ? AND captured_at > ? AND captured_at <= ?
       ORDER BY captured_at DESC, id DESC LIMIT 1`,
      [deviceId, from, to]
    );
    return mapRow(rows[0]) ?? null;
  }

  // All snapshots for a device captured within [from, to], oldest-first — the
  // config-change events for the incident-cluster timeline read-model. Metadata
  // only (no config_text); the timeline just needs the "a change happened" marker
  // + captured_via, not the diff. Bounded like listForDevice.
  async function listForDeviceBetween(deviceId, from, to, { limit = 500 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 2000 ? limit : 500;
    const where = ['device_id = ?'];
    const params = [deviceId];
    if (from) { where.push('captured_at >= ?'); params.push(from); }
    if (to) { where.push('captured_at <= ?'); params.push(to); }
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT ${META_COLUMNS} FROM config_snapshots
       WHERE ${where.join(' AND ')} ORDER BY captured_at ASC, id ASC LIMIT ?`,
      params
    );
    return rows.map(mapRow);
  }

  // The snapshot immediately preceding `id` for the same device (the one to diff
  // against), or null when `id` is the device's first snapshot. Ordered by
  // captured_at then id so ties are deterministic.
  async function previousBefore(deviceId, id) {
    const [rows] = await pool.query(
      `SELECT ${FULL_COLUMNS} FROM config_snapshots
       WHERE device_id = ? AND id <> ?
         AND (captured_at, id) < (SELECT captured_at, id FROM config_snapshots WHERE id = ?)
       ORDER BY captured_at DESC, id DESC LIMIT 1`,
      [deviceId, id, id]
    );
    return mapRow(rows[0]) ?? null;
  }

  return { insert, findById, listForDevice, listForDeviceBetween, previousBefore, latestForDeviceBetween };
}

module.exports = { createConfigSnapshotsRepository, mapRow };
