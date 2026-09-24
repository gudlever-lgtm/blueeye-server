'use strict';

// TSDB variant of the flow-records WRITE path (docs/storage-split-audit.md).
// Rows land in the TimescaleDB `flow_records` hypertable
// (server/db/timescale/001_init.sql), which also feeds the `flow_rollup`
// continuous aggregate.
//
// Write-only for now: it is the mirror half of the dual-write. MySQL stays the
// source of truth and every read keeps going there until the read cutover.
//
// ONE STATEMENT, ONE PARAMETER PER COLUMN, HOWEVER MANY ROWS. A flow report
// fans out to hundreds of rows (topTalkers × byPort × byProtocol), and a
// multi-row VALUES list with nineteen placeholders per row hits Postgres'
// 65 535-parameter ceiling at ~3 400 rows. `unnest()` over one typed array per
// column sends the whole batch as one parameter per column, with no extra
// dependency (COPY would need pg-copy-streams).
//
// The column list is THIS table's, not the MySQL repository's: a column added
// to MySQL flow_records is not mirrored until it is added to the hypertable as
// well — the mirror never fails a batch over a column the TSDB node cannot hold.
//
// A NODE THAT HAS NOT BEEN RE-MIGRATED. `vlan`, `in_if` and `out_if` (MySQL
// migration 127) were added to the hypertable after 001_init.sql first shipped.
// A TimescaleDB node is migrated by re-running that file, a separate step from
// the MySQL migrations, so a node that has not had it yet answers "no such
// column" (42703). The insert then falls back to the original sixteen columns
// and stays there, the same pattern as probeResultsTsdbRepository.

const { COLUMNS: MYSQL_COLUMNS, toRow: toMysqlRow } = require('./flowsRepository');

const LEGACY_COLUMNS = [
  ['agent_id', 'int'], ['ts', 'timestamptz'], ['src_ip', 'text'], ['dst_ip', 'text'],
  ['ext_ip', 'text'], ['direction', 'text'], ['proto', 'text'], ['src_port', 'int'],
  ['dst_port', 'int'], ['bytes', 'bigint'], ['packets', 'bigint'], ['flows', 'int'],
  ['internal', 'boolean'], ['country', 'text'], ['asn', 'bigint'], ['asn_name', 'text'],
];
const COLUMNS = [
  ...LEGACY_COLUMNS,
  ['vlan', 'int'], ['in_if', 'bigint'], ['out_if', 'bigint'],
];

// Postgres: "column … does not exist".
const UNDEFINED_COLUMN = '42703';

const intOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

// Maps one geo-enriched flow record (the camelCase shape flowPipeline hands
// flowsRepository.insertMany) to this table's column values, in COLUMNS order.
// vlan / in_if / out_if go through the MySQL repository's own range checks, so
// the two stores agree on which values are real.
function toValues(r) {
  const ts = r.ts instanceof Date ? r.ts : (r.ts ? new Date(r.ts) : new Date());
  const mysqlRow = toMysqlRow(r);
  return [
    intOrNull(r.agentId),
    ts,
    r.srcIp ?? null,
    r.dstIp ?? null,
    r.extIp ?? null,
    r.direction ?? null,
    r.proto ?? null,
    intOrNull(r.srcPort),
    intOrNull(r.dstPort),
    Number(r.bytes) || 0,
    Number(r.packets) || 0,
    Number(r.flows) || 0,
    !!r.internal,
    // CHAR(2): anything else is not a country code and would fail the batch.
    typeof r.country === 'string' && r.country.length === 2 ? r.country : null,
    intOrNull(r.asn),
    r.asnName ?? null,
    mysqlRow[MYSQL_COLUMNS.indexOf('vlan')],
    mysqlRow[MYSQL_COLUMNS.indexOf('in_if')],
    mysqlRow[MYSQL_COLUMNS.indexOf('out_if')],
  ];
}

function createFlowsTsdbRepository(tsdb, { logger = null } = {}) {
  const { pool } = tsdb;
  // Set once a node has answered "no such column", so every later insert goes
  // straight to the legacy shape instead of failing first.
  let legacy = false;

  async function insertWith(columnDefs, columns) {
    const res = await pool.query(
      `INSERT INTO flow_records (${columnDefs.map(([c]) => c).join(', ')})
       SELECT * FROM unnest(${columnDefs.map(([, type], i) => `$${i + 1}::${type}[]`).join(', ')})`,
      columns.slice(0, columnDefs.length),
    );
    return res.rowCount;
  }

  // Inserts a batch of geo-enriched flow records. Returns rows inserted.
  async function insertMany(records) {
    const list = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === 'object');
    if (!list.length) return 0;
    const columns = COLUMNS.map(() => []);
    for (const r of list) {
      const values = toValues(r);
      values.forEach((v, i) => columns[i].push(v));
    }
    if (legacy) return insertWith(LEGACY_COLUMNS, columns);
    try {
      return await insertWith(COLUMNS, columns);
    } catch (err) {
      if (!err || err.code !== UNDEFINED_COLUMN) throw err;
      legacy = true;
      if (logger) {
        logger.warn('tsdb: flow_records is missing the vlan/in_if/out_if columns — '
          + 're-run server/db/timescale/001_init.sql; mirroring without them until then');
      }
      return insertWith(LEGACY_COLUMNS, columns);
    }
  }

  return { insertMany };
}

module.exports = {
  createFlowsTsdbRepository, COLUMNS, LEGACY_COLUMNS, toValues,
};
