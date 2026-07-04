'use strict';

const fs = require('fs');

// TimescaleDB size, chunk-inclusive for hypertables. Plain PostgreSQL only
// counts the parent relation of a hypertable (chunks live in
// `_timescaledb_internal`), so hypertable rows must be measured with
// `hypertable_size()`; everything else uses `pg_total_relation_size`.
const TSDB_TABLES_SQL = `
  WITH ht AS (
    SELECT format('%I.%I', hypertable_schema, hypertable_name)::regclass AS oid,
           hypertable_name AS name
    FROM timescaledb_information.hypertables
  )
  SELECT name, bytes, "rows", hypertable FROM (
    SELECT ht.name AS name,
           hypertable_size(ht.oid) AS bytes,
           (SELECT reltuples::bigint FROM pg_class WHERE oid = ht.oid) AS "rows",
           true AS hypertable
    FROM ht
    UNION ALL
    SELECT c.relname AS name,
           pg_total_relation_size(c.oid) AS bytes,
           c.reltuples::bigint AS "rows",
           false AS hypertable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM ht WHERE ht.oid = c.oid)
  ) t
  ORDER BY bytes DESC
  LIMIT 20`;

// Fallback for a plain PostgreSQL node (no TimescaleDB extension): the TS-aware
// query above references timescaledb_information, which wouldn't exist.
const PG_TABLES_SQL = `
  SELECT c.relname AS name,
         pg_total_relation_size(c.oid) AS bytes,
         c.reltuples::bigint AS "rows",
         false AS hypertable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public'
  ORDER BY bytes DESC
  LIMIT 20`;

// Server-side storage info: free/used space on the drive where the app/Docker
// volume lives, the MySQL database size, and — when the TimescaleDB telemetry
// store is wired (docs/storage-split-audit.md) — its size too. No external
// dependencies beyond the injected pools: uses fs.statfs, information_schema
// (MySQL), and pg_catalog / timescaledb_information (TSDB).
//
// Note on Docker: the DB volume is mounted in the *db* container, so the server
// process can't statfs it directly. We therefore (a) read DB size over SQL, and
// (b) statfs a configurable path (default the server's own data dir) — in a
// typical single-host deploy the volumes share the same physical drive.
//
// `tsdb` is optional and DI'd the same way as `db`: a normalized client exposing
// `query(sql, params) -> rows[]` and `databaseName` (see src/tsdb.js). When it
// is absent the TSDB half degrades to `{ configured: false }`.
function createSystemInfo({ db, tsdb = null, diskPath = '/data', statfs = fs.statfs } = {}) {
  // Disk usage for the configured path.
  function getDisk() {
    return new Promise((resolve) => {
      statfs(diskPath, (err, st) => {
        if (err || !st) {
          resolve({ path: diskPath, available: false, error: err ? err.message : 'unavailable' });
          return;
        }
        const blockSize = st.bsize;
        const total = st.blocks * blockSize;
        const free = st.bfree * blockSize; // free to root
        const avail = st.bavail * blockSize; // free to unprivileged users
        const used = total - free;
        resolve({
          path: diskPath,
          available: true,
          totalBytes: total,
          usedBytes: used,
          freeBytes: avail,
          usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
        });
      });
    });
  }

  // Database size from information_schema: total, and the largest tables.
  async function getDatabase() {
    const name = db && db.databaseName ? db.databaseName : undefined;
    const [totals] = await db.pool.query(
      `SELECT
         COALESCE(SUM(data_length + index_length), 0) AS bytes,
         COALESCE(SUM(data_length), 0) AS dataBytes,
         COALESCE(SUM(index_length), 0) AS indexBytes,
         COUNT(*) AS tables
       FROM information_schema.tables
       WHERE table_schema = DATABASE()`
    );
    const [tableRows] = await db.pool.query(
      `SELECT table_name AS name,
              (data_length + index_length) AS bytes,
              table_rows AS \`rows\`
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
       ORDER BY (data_length + index_length) DESC
       LIMIT 20`
    );
    const t = totals[0] || {};
    return {
      name: name || null,
      totalBytes: Number(t.bytes) || 0,
      dataBytes: Number(t.dataBytes) || 0,
      indexBytes: Number(t.indexBytes) || 0,
      tableCount: Number(t.tables) || 0,
      tables: tableRows.map((r) => ({
        name: r.name,
        bytes: Number(r.bytes) || 0,
        rows: Number(r.rows) || 0,
      })),
    };
  }

  // TimescaleDB (telemetry store) size: total database bytes + the largest
  // tables/hypertables. Mirrors getDatabase()'s shape so the dashboard can
  // render both stores the same way. Returns { configured: false } when no TSDB
  // client is wired, so callers can show the split without special-casing.
  async function getTsdb() {
    if (!tsdb || typeof tsdb.query !== 'function') return { configured: false };
    const name = tsdb.databaseName || null;
    const totals = await tsdb.query(
      `SELECT pg_database_size(current_database())::bigint AS bytes,
              (SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public') AS tables`
    );
    const t = (totals && totals[0]) || {};
    // Chunk-inclusive per-table sizes; fall back to plain PostgreSQL if the
    // TimescaleDB extension isn't present on the target node.
    let rows;
    try {
      rows = await tsdb.query(TSDB_TABLES_SQL);
    } catch {
      rows = await tsdb.query(PG_TABLES_SQL);
    }
    const tables = (rows || []).map((r) => ({
      name: r.name,
      bytes: Number(r.bytes) || 0,
      rows: Number(r.rows) || 0,
      hypertable: r.hypertable === true || r.hypertable === 't' || r.hypertable === 1,
    }));
    return {
      configured: true,
      name: name || null,
      totalBytes: Number(t.bytes) || 0,
      tableCount: Number(t.tables) || tables.length,
      hypertableCount: tables.filter((x) => x.hypertable).length,
      tables,
    };
  }

  // Recent ingest: rows + stored payload bytes in the last `minutes` — i.e. how
  // much the measurements/traffic just written are growing storage. Used to
  // estimate space consumption + time-to-full.
  async function getIngest(minutes = 3) {
    const [rows] = await db.pool.query(
      'SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM results WHERE created_at >= (NOW() - INTERVAL ? MINUTE)',
      [minutes]
    );
    const r = rows[0] || {};
    const bytes = Number(r.bytes) || 0;
    const mins = minutes > 0 ? minutes : 1;
    return { minutes, rows: Number(r.c) || 0, bytes, bytesPerDay: Math.round((bytes / mins) * 1440) };
  }

  // All parts, with the database / TSDB / ingest reads each resilient so one
  // store being down doesn't break the disk reading or the other store.
  async function getStorage() {
    const disk = await getDisk();
    let database;
    try {
      database = await getDatabase();
    } catch (err) {
      database = { available: false, error: err.message };
    }
    let tsdbInfo;
    try {
      tsdbInfo = await getTsdb();
    } catch (err) {
      // A wired-but-unreachable TSDB reports configured-but-unavailable, so the
      // dashboard shows the split with an error rather than hiding the column.
      tsdbInfo = { configured: true, available: false, error: err.message };
    }
    let ingest = null;
    try {
      ingest = await getIngest(3);
    } catch {
      ingest = null;
    }
    return { at: new Date().toISOString(), disk, database, tsdb: tsdbInfo, ingest };
  }

  return { getDisk, getDatabase, getTsdb, getIngest, getStorage };
}

module.exports = { createSystemInfo };
