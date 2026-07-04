'use strict';

// Logging — the OPERATIONAL/diagnostic stream (distinct from the AUDIT trail in
// src/middleware/auditLogger.js + the audit repositories, which is the durable
// "who did what" security record). See docs/audit-vs-logging.md.
//
// A no-op logger, the default in createApp() so unit tests stay quiet, and the
// structured `createLogger` factory wired by src/server.js.

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return silentLogger; },
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function normalizeLevel(level) {
  const l = String(level || '').toLowerCase();
  return LEVELS[l] !== undefined ? l : 'info';
}

// Splits the console-style extra args into a JSON `meta` object and a flat text
// `extra` string. Errors render their message (and stack when asked), so the
// drop-in call `logger.error('failed', err)` keeps working and improves.
function splitArgs(args, includeStack) {
  const meta = {};
  const parts = [];
  for (const a of args) {
    if (a instanceof Error) {
      meta.err = a.message;
      parts.push(includeStack && a.stack ? a.stack : a.message);
    } else if (a && typeof a === 'object') {
      Object.assign(meta, a);
      try { parts.push(JSON.stringify(a)); } catch { parts.push(String(a)); }
    } else if (a !== undefined) {
      parts.push(String(a));
    }
  }
  return { meta, extra: parts.join(' ') };
}

// Structured, dependency-free logger. Drop-in for the console-style call sites
// (`logger.info('msg', err)`) but adds level filtering, ISO timestamps, optional
// JSON output (LOG_FORMAT=json) and child() bindings for per-request correlation
// (req.id). Sinks are injectable so tests capture lines without touching streams.
function createLogger({
  level = process.env.LOG_LEVEL || 'info',
  format = process.env.LOG_FORMAT || 'text',
  clock = () => new Date(),
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  bindings = {},
  // Optional structured-record sink (e.g. an in-memory ring buffer surfaced in
  // the dashboard). Receives every emitted record; a throw here must never break
  // the app, so the call site guards it.
  onRecord = null,
} = {}) {
  const min = LEVELS[normalizeLevel(level)];
  const json = String(format).toLowerCase() === 'json';

  function emit(name, args) {
    if (LEVELS[name] < min) return;
    const ts = clock().toISOString();
    const message = args.length && typeof args[0] === 'string' ? args[0] : '';
    const rest = message ? args.slice(1) : args;
    const includeStack = name === 'error' || min <= LEVELS.debug;
    const { meta, extra } = splitArgs(rest, includeStack);
    const sink = LEVELS[name] >= LEVELS.warn ? stderr : stdout;
    if (onRecord) {
      // Never let a buffer/sink failure take down the caller's real work.
      try { onRecord({ ts, level: name, msg: message, source: 'server', meta: { ...bindings, ...meta, ...(extra ? { extra } : {}) } }); } catch { /* ignore */ }
    }
    if (json) {
      sink(JSON.stringify({ ts, level: name, msg: message, ...bindings, ...meta }));
    } else {
      const tag = Object.keys(bindings).length
        ? ` ${Object.entries(bindings).map(([k, v]) => `${k}=${v}`).join(' ')}`
        : '';
      sink(`${ts} ${name.toUpperCase()}${tag} ${message}${extra ? ` ${extra}` : ''}`.trimEnd());
    }
  }

  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    // A logger that carries extra bindings (e.g. { reqId }) on every line.
    child: (extra = {}) => createLogger({ level, format, clock, stdout, stderr, bindings: { ...bindings, ...extra }, onRecord }),
    level,
  };
}

// In-memory ring buffer of structured log records, surfaced (admin-only) in the
// dashboard's Logs view. Holds the most recent `capacity` records; oldest drop
// off. Also accepts client-reported records (source: 'client') so browser-side
// action failures show up in the same merged stream. Cleared on restart — this
// is a live diagnostic aid, not a durable audit trail.
function createLogRing({ capacity = 1000, clock = () => new Date() } = {}) {
  const buf = [];
  let seq = 0;
  function record(entry = {}) {
    seq += 1;
    const row = {
      id: entry.id || `s${seq}`,
      ts: entry.ts || clock().toISOString(),
      level: normalizeLevel(entry.level),
      msg: typeof entry.msg === 'string' ? entry.msg : '',
      source: entry.source === 'client' ? 'client' : 'server',
      meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {},
    };
    buf.push(row);
    if (buf.length > capacity) buf.shift();
    return row;
  }
  function list({ level, since, q, limit = 200 } = {}) {
    let rows = buf;
    if (level && LEVELS[normalizeLevel(level)] !== undefined) {
      const min = LEVELS[normalizeLevel(level)];
      rows = rows.filter((r) => (LEVELS[r.level] || 0) >= min);
    }
    if (since) {
      const t = Date.parse(since);
      if (!Number.isNaN(t)) rows = rows.filter((r) => Date.parse(r.ts) >= t);
    }
    if (q) {
      const s = String(q).toLowerCase();
      rows = rows.filter((r) => r.msg.toLowerCase().includes(s) || JSON.stringify(r.meta).toLowerCase().includes(s));
    }
    // Newest first, capped.
    return rows.slice(-Math.min(Math.max(1, limit), capacity)).reverse();
  }
  return { record, list, get size() { return buf.length; }, capacity };
}

module.exports = { silentLogger, createLogger, createLogRing, LEVELS };
