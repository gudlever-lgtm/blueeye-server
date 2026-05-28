'use strict';

const mysql = require('mysql2/promise');

// Creates a MySQL connection pool plus a couple of small helpers. The pool is
// the single shared entry point for all database access in the running server.
function createDb(config) {
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    connectionLimit: config.db.connectionLimit,
    waitForConnections: true,
    queueLimit: 0,
    charset: 'utf8mb4_unicode_ci',
  });

  // Lightweight liveness check used by GET /health.
  async function ping() {
    const conn = await pool.getConnection();
    try {
      await conn.ping();
    } finally {
      conn.release();
    }
  }

  async function close() {
    await pool.end();
  }

  return { pool, ping, close };
}

module.exports = { createDb };
