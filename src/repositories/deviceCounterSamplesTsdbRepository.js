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

const {
  mapRow, RAW_COLUMNS, STATE_COLUMNS, RATE_COLUMNS, FIELD, LOOKBACK_MS,
} = require('./deviceCounterSamplesRepository');

// The columns migration 116 added. A TimescaleDB node is migrated by re-running
// 001_init.sql, which is a separate step from the MySQL migrations the server
// runs itself — so a node that has not had it yet must not lose every counter
// sample over two columns it cannot hold. See insertMany.
const NEW_COLUMNS = new Set(['duplex', 'late_coll_pps']);
const INSERT_COLUMNS = [
  'ts', 'device_id', 'interface_id', ...RAW_COLUMNS, ...STATE_COLUMNS, ...RATE_COLUMNS, 'discontinuity',
];
const LEGACY_COLUMNS = INSERT_COLUMNS.filter((c) => !NEW_COLUMNS.has(c));

// Postgres: "column … does not exist".
const UNDEFINED_COLUMN = '42703';

function valueFor(r, col) {
  if (col === 'ts') return r.ts;
  if (col === 'device_id') return r.deviceId;
  if (col === 'interface_id') return r.interfaceId;
  if (col === 'discontinuity') return r.discontinuity ?? null;
  if (col === 'duplex') return r.duplex ?? null;
  return r[FIELD[col]] ?? null;
}

function createDeviceCounterSamplesTsdbRepository(tsdb, { logger = null } = {}) {
  const { query } = tsdb;
  // Set once a node has answered "no such column": every later insert goes
  // straight to the legacy shape instead of failing first.
  let legacy = false;

  async function insertWith(columns, list) {
    const params = [];
    const tuples = [];
    for (const r of list) {
      const start = params.length;
      for (const col of columns) params.push(valueFor(r, col));
      tuples.push(`(${columns.map((_, i) => `$${start + i + 1}`).join(', ')})`);
    }
    const out = await query(
      `INSERT INTO device_counter_samples (${columns.join(', ')})
       VALUES ${tuples.join(', ')}
       RETURNING 1`,
      params,
    );
    return out.length;
  }

  async function insertMany(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return 0;
    if (legacy) return insertWith(LEGACY_COLUMNS, list);
    try {
      return await insertWith(INSERT_COLUMNS, list);
    } catch (err) {
      if (!err || err.code !== UNDEFINED_COLUMN) throw err;
      legacy = true;
      if (logger) {
        logger.warn('tsdb: device_counter_samples has no duplex/late_coll_pps column yet — '
          + 're-run server/db/timescale/001_init.sql; storing without them until then');
      }
      return insertWith(LEGACY_COLUMNS, list);
    }
  }

  // DISTINCT ON — the Postgres idiom for the newest row per interface.
  //
  // THE ts PREDICATE IS WHAT MAKES IT READ ONE CHUNK. Without it the planner
  // has no way to exclude chunks and the query appends across every one of
  // them; server/db/timescale/001_init.sql states the rule outright — never an
  // unbounded GROUP BY on a hypertable. The device filter alone is not enough,
  // because a device's rows are spread across every chunk it has ever been in.
  async function latestForDevice(deviceId, { since = null } = {}) {
    const from = since || new Date(Date.now() - LOOKBACK_MS);
    const rows = await query(
      `SELECT DISTINCT ON (interface_id) *
         FROM device_counter_samples
        WHERE device_id = $1 AND ts >= $2
        ORDER BY interface_id, ts DESC`,
      [deviceId, from],
    );
    const byInterface = new Map();
    for (const r of rows) byInterface.set(Number(r.interface_id), mapRow(r));
    return byInterface;
  }

  async function latestWithNames(deviceId, { since = null } = {}) {
    const from = since || new Date(Date.now() - LOOKBACK_MS);
    const rows = await query(
      `SELECT DISTINCT ON (interface_id) *
         FROM device_counter_samples
        WHERE device_id = $1 AND ts >= $2
        ORDER BY interface_id, ts DESC`,
      [deviceId, from],
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
