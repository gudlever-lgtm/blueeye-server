'use strict';

const { Pool } = require('pg');

// Creates a PostgreSQL/TimescaleDB connection pool for the telemetry layer,
// mirroring src/db.js. This is the single shared entry point for all telemetry
// (TSDB) access, kept separate from the MySQL pool per the storage split
// (docs/storage-split-audit.md).
//
// Only constructed when TSDB is configured (config.tsdb.enabled). When it is
// not, server.js passes tsdb=null and the rest of the server behaves exactly as
// before — telemetry stays in MySQL, MySQL remains the source of truth.
function createTsdb(config) {
  const pool = new Pool({
    host: config.tsdb.host,
    port: config.tsdb.port,
    user: config.tsdb.user,
    password: config.tsdb.password,
    database: config.tsdb.database,
    max: config.tsdb.connectionLimit,
    connectionTimeoutMillis: config.tsdb.connectionTimeoutMs,
  });

  // pg emits 'error' on the pool when an idle backend dies (e.g. TSDB restart).
  // Without a listener that would crash the process; swallow it — the next
  // query reconnects, and callers already treat TSDB writes as best-effort.
  pool.on('error', () => {});

  // Lightweight liveness check used by GET /health when TSDB is enabled.
  async function ping() {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  }

  async function close() {
    await pool.end();
  }

  return { pool, ping, close, databaseName: config.tsdb.database };
}

module.exports = { createTsdb };
