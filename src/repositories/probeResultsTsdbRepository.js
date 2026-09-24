'use strict';

// TSDB variant of the probe-results WRITE path (docs/storage-split-audit.md).
// Rows land in the TimescaleDB `probe_results` hypertable
// (server/db/timescale/001_init.sql).
//
// Write-only for now: the mirror half of the dual-write. MySQL stays the source
// of truth and every read (availability, fleet health, the probe charts) keeps
// going there until the read cutover.
//
// ONE NORMALISATION, NOT TWO. Each result goes through the MySQL repository's
// own toRow() — the same truncation, the same JSON encoding, the same "no ts
// means now" — and is then picked by column NAME, so the two stores cannot
// disagree about what a result said, and a column the MySQL side gains later is
// simply not mirrored until the hypertable has it too.
//
// A NODE THAT HAS NOT BEEN RE-MIGRATED. The columns after `hops` (the HTTP,
// path-MTU, TLS, rDNS and failure-reason fields, then the DHCP offers) were
// added to the hypertable after 001_init.sql first shipped. A TimescaleDB node
// is migrated by re-running that file, a separate step from the MySQL
// migrations the server runs itself, so a node that has not had it yet answers
// "no such column" — and must not lose every probe result over columns it
// cannot hold. The insert then steps down one column set at a time (the set
// before `dhcp`, then the original one), the same pattern as
// deviceCounterSamplesTsdbRepository, so a node re-migrated once but not since
// keeps the columns it does have.

const { COLUMNS: MYSQL_COLUMNS, toRow } = require('./probeResultsRepository');

const LEGACY_COLUMNS = [
  'agent_id', 'ts', 'type', 'target', 'ok', 'rtt_ms', 'min_ms', 'max_ms',
  'jitter_ms', 'loss_pct', 'status', 'cert_expiry_days', 'hops', 'detail',
];
// Added in 001_init.sql's first forward migration (MySQL 096/101/121).
const FIRST_ADDED = [
  'bytes', 'content_type', 'elements', 'mtu', 'sizes', 'tls', 'rdns',
  'error_code', 'failure', 'resolver',
];
// Added later: the DHCP offers (MySQL migration 132).
const ADDED_COLUMNS = [...FIRST_ADDED, 'dhcp'];
const INSERT_COLUMNS = [...LEGACY_COLUMNS, ...ADDED_COLUMNS];
// Newest first: what an insert steps down through on "no such column".
const COLUMN_SETS = [INSERT_COLUMNS, [...LEGACY_COLUMNS, ...FIRST_ADDED], LEGACY_COLUMNS];
const INTEGER_COLUMNS = ['status', 'cert_expiry_days', 'bytes'];

// Postgres: "column … does not exist".
const UNDEFINED_COLUMN = '42703';

// One result → { column: value } for this table.
function toRecord(agentId, r) {
  const values = toRow(agentId, r);
  const rec = {};
  MYSQL_COLUMNS.forEach((c, i) => { rec[c] = values[i]; });
  rec.ok = !!rec.ok; // MySQL TINYINT 1/0 → BOOLEAN
  // Integer columns: MySQL rounds a fractional value silently, Postgres refuses
  // it and would fail the whole batch (a certificate 12.5 days from expiry).
  for (const c of INTEGER_COLUMNS) {
    if (rec[c] != null) rec[c] = Number.isFinite(Number(rec[c])) ? Math.round(Number(rec[c])) : null;
  }
  return rec;
}

function createProbeResultsTsdbRepository(tsdb, { logger = null } = {}) {
  const { pool } = tsdb;
  // Index into COLUMN_SETS. Moves down once a node has answered "no such
  // column", so every later insert goes straight to the shape it can hold
  // instead of failing first.
  let level = 0;

  async function insertWith(columns, records) {
    const params = [];
    const tuples = records.map((rec) => {
      const start = params.length;
      for (const c of columns) params.push(rec[c] === undefined ? null : rec[c]);
      return `(${columns.map((_, i) => `$${start + i + 1}`).join(', ')})`;
    });
    const res = await pool.query(
      `INSERT INTO probe_results (${columns.join(', ')}) VALUES ${tuples.join(', ')}`,
      params,
    );
    return res.rowCount;
  }

  // Mirrors a batch of validated probe results for one agent. A probe POST is a
  // handful of rows, so a parameterized multi-row INSERT is enough. Returns
  // rows inserted.
  async function createMany(agentId, results) {
    const list = (Array.isArray(results) ? results : []).filter((r) => r && typeof r === 'object');
    if (!list.length) return 0;
    const records = list.map((r) => toRecord(agentId, r));
    for (;;) {
      try {
        return await insertWith(COLUMN_SETS[level], records);
      } catch (err) {
        if (!err || err.code !== UNDEFINED_COLUMN || level >= COLUMN_SETS.length - 1) throw err;
        if (logger && level === 0) {
          logger.warn('tsdb: probe_results is missing columns added to 001_init.sql since it was last run — '
            + 're-run server/db/timescale/001_init.sql; mirroring without them until then');
        }
        level += 1;
      }
    }
  }

  return { createMany };
}

module.exports = {
  createProbeResultsTsdbRepository, INSERT_COLUMNS, LEGACY_COLUMNS, COLUMN_SETS, toRecord,
};
