'use strict';

// TSDB variant of the counter-samples repository
// (docs/storage-split-audit.md). Writes land in the TimescaleDB
// `device_counter_samples` hypertable.
//
// The read shape is IDENTICAL to deviceCounterSamplesRepository.js — same
// camelCase objects, same ordering, same Map from latestForDevice — so the
// ingest and the routes never learn which store answered.
//
// TWO REAL DIFFERENCES, both consequences of a hypertable:
//
//   * No UNIQUE (interface_id, ts) to lean on for idempotency, so the insert
//     uses ON CONFLICT DO NOTHING against a plain unique index where one
//     exists and is otherwise tolerant of a retried submit: the second copy of
//     a sample carries the same numbers anyway.
//   * `latestForDevice` uses DISTINCT ON, which is the Postgres idiom for "the
//     newest row per group" and reads one chunk rather than joining a grouped
//     subquery against the whole table.
//
// The port NAME lives in MySQL (`device_interfaces`), so `latestWithNames`
// cannot join here. It returns the samples and the caller decorates them — the
// same split the device-events reader already makes for agent names.

const { mapRow, RAW_COLUMNS, RATE_COLUMNS, FIELD } = require('./deviceCounterSamplesRepository');

const INSERT_COLUMNS = ['ts', 'device_id', 'interface_id', ...RAW_COLUMNS, ...RATE_COLUMNS, 'discontinuity'];

function createDeviceCounterSamplesTsdbRepository(tsdb) {
  const { query } = tsdb;

  async function insertMany(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return 0;

    const params = [];
    const tuples = [];
    for (const r of list) {
      const start = params.length;
      params.push(r.ts, r.deviceId, r.interfaceId);
      for (const col of RAW_COLUMNS) params.push(r[FIELD[col]] ?? null);
      for (const col of RATE_COLUMNS) params.push(r[FIELD[col]] ?? null);
      params.push(r.discontinuity ?? null);
      tuples.push(`(${INSERT_COLUMNS.map((_, i) => `$${start + i + 1}`).join(', ')})`);
    }

    const out = await query(
      `INSERT INTO device_counter_samples (${INSERT_COLUMNS.join(', ')})
       VALUES ${tuples.join(', ')}
       RETURNING 1`,
      params,
    );
    return out.length;
  }

  // DISTINCT ON — the Postgres idiom for the newest row per interface. The
  // device filter plus the (interface_id, ts DESC) index means this reads the
  // current chunk rather than the table.
  async function latestForDevice(deviceId) {
    const rows = await query(
      `SELECT DISTINCT ON (interface_id) *
         FROM device_counter_samples
        WHERE device_id = $1
        ORDER BY interface_id, ts DESC`,
      [deviceId],
    );
    const byInterface = new Map();
    for (const r of rows) byInterface.set(Number(r.interface_id), mapRow(r));
    return byInterface;
  }

  async function latestWithNames(deviceId) {
    const rows = await query(
      `SELECT DISTINCT ON (interface_id) *
         FROM device_counter_samples
        WHERE device_id = $1
        ORDER BY interface_id, ts DESC`,
      [deviceId],
    );
    return rows.map(mapRow);
  }

  async function series(interfaceId, { from, to, maxPoints = 500 } = {}) {
    const counted = await query(
      'SELECT COUNT(*)::int AS n FROM device_counter_samples WHERE interface_id = $1 AND ts >= $2 AND ts <= $3',
      [interfaceId, from, to],
    );
    const total = Number((counted[0] && counted[0].n) || 0);
    const step = total > maxPoints ? Math.ceil(total / maxPoints) : 1;

    const rows = await query(
      `SELECT * FROM device_counter_samples
        WHERE interface_id = $1 AND ts >= $2 AND ts <= $3
        ORDER BY ts ASC`,
      [interfaceId, from, to],
    );
    const picked = step === 1 ? rows : rows.filter((_, i) => i % step === 0);
    return { total, step, samples: picked.map(mapRow) };
  }

  // A no-op that reports it. TimescaleDB expires these chunks with its own
  // retention policy (server/db/timescale/001_init.sql), so the application
  // purge has nothing to do — and says 0 rather than pretending it swept.
  async function purgeBefore() {
    return 0;
  }

  return { insertMany, latestForDevice, latestWithNames, series, purgeBefore };
}

module.exports = { createDeviceCounterSamplesTsdbRepository };
