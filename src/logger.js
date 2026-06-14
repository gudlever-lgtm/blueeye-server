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
    child: (extra = {}) => createLogger({ level, format, clock, stdout, stderr, bindings: { ...bindings, ...extra } }),
    level,
  };
}

module.exports = { silentLogger, createLogger, LEVELS };
