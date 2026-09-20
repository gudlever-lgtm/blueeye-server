'use strict';

const { numOrNull } = require('../lib/num');

// Data-access for `device_counter_samples` (migration 109) — interface counters
// from polled switches, over time.
//
// The MySQL variant. `deviceCounterSamplesTsdbRepository.js` is the other one,
// with an identical read shape, so nothing upstream learns which store
// answered (docs/storage-split-audit.md).
//
// TWO READS MATTER HERE and they are not the obvious ones:
//
//   * `latestForDevice` is on the WRITE path. Every sample's rates are computed
//     against the previous reading for the same interface, so the ingest reads
//     one row per port before it writes — a single indexed query per device per
//     cycle, not a query per port.
//   * `series` is the screen. It takes a window and downsamples, because a
//     24-hour window at 60 s is 1440 points and the chart draws 760 pixels
//     wide.

const RAW_COLUMNS = [
  'in_octets', 'out_octets', 'in_ucast_pkts', 'out_ucast_pkts',
  'in_mcast_pkts', 'in_bcast_pkts', 'out_mcast_pkts', 'out_bcast_pkts',
  'in_errors', 'out_errors', 'in_discards', 'out_discards',
  'fcs_errors', 'alignment_errors', 'late_collisions', 'carrier_sense_errors',
];
const RATE_COLUMNS = [
  'delta_sec', 'in_bps', 'out_bps', 'in_err_pps', 'out_err_pps',
  'in_disc_pps', 'out_disc_pps', 'fcs_pps', 'in_bcast_pps',
  'in_util_pct', 'out_util_pct',
];
const ALL_COLUMNS = ['ts', 'device_id', 'interface_id', ...RAW_COLUMNS, ...RATE_COLUMNS, 'discontinuity'];

// row key -> the camelCase field the rest of the server uses.
const FIELD = {
  in_octets: 'inOctets', out_octets: 'outOctets',
  in_ucast_pkts: 'inUcastPkts', out_ucast_pkts: 'outUcastPkts',
  in_mcast_pkts: 'inMcastPkts', in_bcast_pkts: 'inBcastPkts',
  out_mcast_pkts: 'outMcastPkts', out_bcast_pkts: 'outBcastPkts',
  in_errors: 'inErrors', out_errors: 'outErrors',
  in_discards: 'inDiscards', out_discards: 'outDiscards',
  fcs_errors: 'fcsErrors', alignment_errors: 'alignmentErrors',
  late_collisions: 'lateCollisions', carrier_sense_errors: 'carrierSenseErrors',
  delta_sec: 'deltaSec', in_bps: 'inBps', out_bps: 'outBps',
  in_err_pps: 'inErrPps', out_err_pps: 'outErrPps',
  in_disc_pps: 'inDiscPps', out_disc_pps: 'outDiscPps',
  fcs_pps: 'fcsPps', in_bcast_pps: 'inBcastPps',
  in_util_pct: 'inUtilPct', out_util_pct: 'outUtilPct',
};

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}


function mapRow(row) {
  if (!row) return null;
  const out = {
    ts: toIso(row.ts),
    deviceId: Number(row.device_id),
    interfaceId: Number(row.interface_id),
    discontinuity: row.discontinuity ?? null,
  };
  for (const [col, field] of Object.entries(FIELD)) out[field] = numOrNull(row[col]);
  if (row.if_name !== undefined) out.ifName = row.if_name;
  return out;
}

function createDeviceCounterSamplesRepository(db) {
  const { pool } = db;

  // Inserts one cycle's samples. IGNORE on the unique (interface_id, ts): a
  // retried submit must not double-count, and the second copy of a sample
  // carries the same numbers anyway.
  async function insertMany(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return 0;

    const placeholders = [];
    const params = [];
    for (const r of list) {
      placeholders.push(`(${ALL_COLUMNS.map(() => '?').join(', ')})`);
      params.push(r.ts, r.deviceId, r.interfaceId);
      for (const col of RAW_COLUMNS) params.push(r[FIELD[col]] ?? null);
      for (const col of RATE_COLUMNS) params.push(r[FIELD[col]] ?? null);
      params.push(r.discontinuity ?? null);
    }

    const [res] = await pool.query(
      `INSERT IGNORE INTO device_counter_samples (${ALL_COLUMNS.join(', ')})
       VALUES ${placeholders.join(', ')}`,
      params,
    );
    return Number(res.affectedRows || 0);
  }

  // The newest sample per interface on one device. This is the WRITE path's
  // read: the rates for a new cycle are computed against these, one query per
  // device rather than one per port.
  async function latestForDevice(deviceId) {
    const [rows] = await pool.query(
      `SELECT s.* FROM device_counter_samples s
         JOIN (
           SELECT interface_id, MAX(ts) AS ts
             FROM device_counter_samples
            WHERE device_id = ?
            GROUP BY interface_id
         ) newest ON newest.interface_id = s.interface_id AND newest.ts = s.ts
        WHERE s.device_id = ?`,
      [deviceId, deviceId],
    );
    const byInterface = new Map();
    for (const r of rows) byInterface.set(Number(r.interface_id), mapRow(r));
    return byInterface;
  }

  // One port's series over a window, newest last. `maxPoints` downsamples by
  // taking every Nth row: a 24-hour window at 60 s is 1440 points against a
  // chart 760 pixels wide, and averaging would smooth away the error spikes
  // that are the entire reason somebody opened it.
  async function series(interfaceId, { from, to, maxPoints = 500 } = {}) {
    const [[countRow]] = await pool.query(
      'SELECT COUNT(*) AS n FROM device_counter_samples WHERE interface_id = ? AND ts >= ? AND ts <= ?',
      [interfaceId, from, to],
    );
    const total = Number((countRow && countRow.n) || 0);
    const step = total > maxPoints ? Math.ceil(total / maxPoints) : 1;

    const [rows] = await pool.query(
      `SELECT ${ALL_COLUMNS.join(', ')} FROM device_counter_samples
        WHERE interface_id = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC`,
      [interfaceId, from, to],
    );
    const picked = step === 1 ? rows : rows.filter((_, i) => i % step === 0);
    return { total, step, samples: picked.map(mapRow) };
  }

  // The newest sample for every port on a device, with the port's name — the
  // per-device table on the screen.
  async function latestWithNames(deviceId) {
    const [rows] = await pool.query(
      `SELECT s.*, i.if_name
         FROM device_counter_samples s
         JOIN device_interfaces i ON i.id = s.interface_id
         JOIN (
           SELECT interface_id, MAX(ts) AS ts
             FROM device_counter_samples
            WHERE device_id = ?
            GROUP BY interface_id
         ) newest ON newest.interface_id = s.interface_id AND newest.ts = s.ts
        WHERE s.device_id = ?
        ORDER BY i.if_index IS NULL, i.if_index ASC, i.if_name ASC`,
      [deviceId, deviceId],
    );
    return rows.map(mapRow);
  }

  async function purgeBefore(cutoff, { batchSize = 5000 } = {}) {
    let removed = 0;
    for (;;) {
      const [res] = await pool.query(
        'DELETE FROM device_counter_samples WHERE ts < ? ORDER BY ts LIMIT ?',
        [cutoff, batchSize],
      );
      const n = Number(res.affectedRows || 0);
      removed += n;
      if (n < batchSize) break;
    }
    return removed;
  }

  return { insertMany, latestForDevice, latestWithNames, series, purgeBefore };
}

module.exports = {
  createDeviceCounterSamplesRepository,
  mapRow,
  RAW_COLUMNS,
  RATE_COLUMNS,
  ALL_COLUMNS,
  FIELD,
};
