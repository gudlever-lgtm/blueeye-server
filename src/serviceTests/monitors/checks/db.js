'use strict';

const { ok, failed, unreachable, misconfigured, KIND } = require('../result');

// "Can the application still talk to its database?"
//
// Between "the web server is up" and "the page works" sits the connection that
// actually fails: a rotated password, a connection limit reached, a replica that
// stopped replicating, a disk that filled. A browser test finds it too — as a
// 500 on a page, three layers away from the cause. One connect and one SELECT
// says which layer it is.
//
// READ-ONLY BY CONTRACT. The validator refuses anything but a single SELECT, and
// this file refuses it again: a monitor runs on a schedule forever, and a
// scheduled statement that can write is a scheduled accident.
//
// Both drivers are already dependencies (mysql2 for BlueEyes itself, pg for the
// Postgres-backed installs), and both are required lazily so a deployment that
// never uses one does not pay for it.

const SELECT_ONLY = /^\s*select\b/i;
const FORBIDDEN = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|call|do|merge|replace|set|copy)\b/i;

function isReadOnly(sql) {
  const q = String(sql || '').trim().replace(/;\s*$/, '');
  if (!q) return false;
  if (!SELECT_ONLY.test(q)) return false;
  // A second statement is how a "SELECT" becomes a write. Anything after a
  // semicolon is refused rather than parsed.
  if (q.includes(';')) return false;
  return !FORBIDDEN.test(q);
}

// The default connectors. Each returns { query(sql) → rows, close() }.
async function defaultConnector({ engine, host, port, database, username, password, timeoutMs, ssl = false }) {
  if (engine === 'postgres') {
    let pg;
    try {
      pg = require('pg'); // eslint-disable-line global-require
    } catch {
      return null;
    }
    const client = new pg.Client({
      host,
      port: port || 5432,
      database: database || undefined,
      user: username || undefined,
      password: password || undefined,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      ssl: ssl ? { rejectUnauthorized: false } : false,
    });
    await client.connect();
    return {
      async query(sql) { const r = await client.query(sql); return r.rows; },
      async close() { try { await client.end(); } catch { /* closing is best-effort */ } },
    };
  }
  let mysql;
  try {
    mysql = require('mysql2/promise'); // eslint-disable-line global-require
  } catch {
    return null;
  }
  const conn = await mysql.createConnection({
    host,
    port: port || 3306,
    database: database || undefined,
    user: username || undefined,
    password: password || undefined,
    connectTimeout: timeoutMs,
  });
  return {
    async query(sql) { const [rows] = await conn.query(sql); return rows; },
    async close() { try { await conn.end(); } catch { /* closing is best-effort */ } },
  };
}

// A refused login and an unreachable host mean different things to whoever is
// woken up. The drivers say so in their error codes.
const AUTH_CODES = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', '28P01', '28000', '3D000']);
const REACH_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'PROTOCOL_CONNECTION_LOST']);

function createDbCheck({ connector = defaultConnector, now = () => Date.now() } = {}) {
  async function check(monitor) {
    const cfg = monitor.config || {};
    const secrets = monitor.secrets || {};
    const engine = cfg.engine === 'postgres' ? 'postgres' : 'mysql';
    const sql = cfg.query || 'SELECT 1';
    if (!cfg.host) return misconfigured({ summary: 'The monitor has no database host.' });
    if (!isReadOnly(sql)) {
      return misconfigured({ summary: 'A database monitor may only run a single SELECT — it refused to run this statement.' });
    }

    const timeoutMs = cfg.timeout_ms || 10000;
    const started = now();
    let handle = null;
    try {
      handle = await connector({
        engine,
        host: cfg.host,
        port: cfg.port || null,
        database: cfg.database || null,
        username: cfg.username || null,
        password: secrets.password || null,
        timeoutMs,
      });
      if (!handle) {
        return misconfigured({ summary: `The ${engine} driver is not installed, so this monitor cannot run.` });
      }
      const connected = now() - started;
      const rows = await handle.query(sql);
      const ms = now() - started;
      return ok({
        summary: `${engine} at ${cfg.host} answered in ${ms} ms (${Array.isArray(rows) ? rows.length : 0} row(s)).`,
        value: ms,
        unit: 'ms',
        durationMs: ms,
        timings: { connect: connected, query: ms - connected },
        detail: {
          engine,
          host: cfg.host,
          port: cfg.port || null,
          database: cfg.database || null,
          query: sql,
          rows: Array.isArray(rows) ? rows.length : 0,
        },
      });
    } catch (err) {
      const message = (err && err.message) || String(err);
      const code = (err && (err.code || err.sqlState)) || null;
      const ms = now() - started;
      const detail = { engine, host: cfg.host, port: cfg.port || null, database: cfg.database || null, code };
      if (REACH_CODES.has(code)) {
        return unreachable({ summary: `Could not reach ${engine} at ${cfg.host}: ${message}`, error: message, durationMs: ms, detail });
      }
      return failed(KIND.DB_QUERY_FAILED, {
        summary: AUTH_CODES.has(code)
          ? `${engine} at ${cfg.host} refused the login: ${message}`
          : `${engine} at ${cfg.host} failed the check: ${message}`,
        error: message,
        durationMs: ms,
        detail,
      });
    } finally {
      if (handle) await handle.close();
    }
  }

  return { check };
}

module.exports = { createDbCheck, isReadOnly };
