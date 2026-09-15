'use strict';

const { createMailCheck } = require('./checks/mail');
const { createDnsCheck } = require('./checks/dns');
const { createRblCheck } = require('./checks/rbl');
const { createLdapCheck } = require('./checks/ldap');
const { createNtpCheck } = require('./checks/ntp');
const { createTlsPortCheck } = require('./checks/tlsPort');
const { createTcpCheck } = require('./checks/tcpPort');
const { createDbCheck } = require('./checks/db');
const { applyThresholds, unknown, STATUS, KIND } = require('./result');
const { typeMeta, defaultsFor } = require('./types');

// type → checker, and the one function that runs one.
//
// Every checker is built with the same injectable I/O it needs and nothing else,
// so a deployment gets the real thing and the suite gets a fake without either
// knowing about the other. `overrides` is how a test replaces one check without
// rebuilding the registry.

function createCheckers({ now = () => Date.now(), overrides = {}, io = {} } = {}) {
  const checkers = {
    mail: createMailCheck({ now, ...(io.mail || {}) }),
    dns_record: createDnsCheck({ now, ...(io.dns || {}) }),
    rbl: createRblCheck({ now, ...(io.rbl || {}) }),
    ldap_bind: createLdapCheck({ now, ...(io.ldap || {}) }),
    ntp_offset: createNtpCheck({ now, ...(io.ntp || {}) }),
    tls_port: createTlsPortCheck({ now, ...(io.tls || {}) }),
    tcp_port: createTcpCheck({ now, ...(io.tcp || {}) }),
    db_connect: createDbCheck({ now, ...(io.db || {}) }),
  };
  return { ...checkers, ...overrides };
}

// Runs one monitor and returns a result — NEVER throws and never hangs the
// caller on a checker that does. A sweep runs every monitor in turn, so one
// check that misbehaves must cost its own row and nothing else.
function createMonitorRunner({ checkers = null, now = () => Date.now(), hardCapMs = 600000, logger = null } = {}) {
  const registry = checkers || createCheckers({ now });

  async function run(monitor) {
    const meta = typeMeta(monitor && monitor.type);
    const checker = registry[monitor && monitor.type];
    if (!meta || !checker) {
      return { status: STATUS.MISCONFIGURED, kind: KIND.MISCONFIGURED, summary: `Unknown monitor type "${monitor && monitor.type}".`, value: null, unit: null, duration_ms: null, timings: null, detail: null, error_message: null };
    }
    // Stored config merged onto the type's defaults, so a field added after the
    // monitor was created has a value instead of being undefined at check time.
    const prepared = { ...monitor, config: { ...defaultsFor(monitor.type), ...(monitor.config || {}) } };

    const started = now();
    let result;
    let cap = null;
    try {
      result = await Promise.race([
        Promise.resolve(checker.check(prepared)),
        new Promise((resolve) => {
          cap = setTimeout(() => resolve({
            status: STATUS.UNKNOWN,
            kind: KIND.UNREACHABLE,
            summary: `The check did not finish within ${Math.round(hardCapMs / 1000)} s.`,
            value: null, unit: null, duration_ms: hardCapMs, timings: null, detail: null, error_message: 'hard cap reached',
          }), hardCapMs);
        }),
      ]);
    } catch (err) {
      if (logger && logger.warn) logger.warn(`monitor ${monitor.id} (${monitor.type}) threw: ${err && err.message}`);
      return unknown({
        summary: `The check could not be completed: ${(err && err.message) || err}`,
        error: (err && err.message) || String(err),
        durationMs: now() - started,
      });
    } finally {
      // The cap is a guarantee, not a leak: whichever side of the race won, the
      // timer is cleared here so a finished check never holds a timer open.
      if (cap) clearTimeout(cap);
    }
    if (!result || typeof result !== 'object') {
      return unknown({ summary: 'The check returned nothing.', durationMs: now() - started });
    }
    const withDuration = {
      ...result,
      duration_ms: Number.isFinite(result.duration_ms) ? result.duration_ms : now() - started,
    };
    return applyThresholds(withDuration, {
      warnMs: Number.isFinite(monitor.warn_ms) ? monitor.warn_ms : null,
      critMs: Number.isFinite(monitor.crit_ms) ? monitor.crit_ms : null,
      slowKind: monitor.type === 'mail' ? KIND.MAIL_SLOW : KIND.SLOW,
      what: meta.measures ? meta.measures.label : 'The check',
    });
  }

  return { run, checkers: registry };
}

// One typed fact for the observation store, so a monitor result is readable by
// the same correlation layer that reads runs. `unknown` is a real outcome and is
// stored as one — "we did not look" must never read as "we looked and it was
// fine".
function observationFor(monitor, result) {
  const meta = typeMeta(monitor.type);
  if (!meta) return null;
  const outcome = result.status === 'ok' ? 'ok' : (result.status === 'unknown' ? 'unknown' : 'bad');
  return {
    layer: meta.layer,
    kind: meta.kind,
    subject: `${monitor.type}:${monitor.target}`,
    outcome,
    value: Number.isFinite(result.value) ? result.value : null,
    unit: result.unit || null,
    summary: result.summary || null,
    detail: result.detail || null,
  };
}

module.exports = { createMonitorRunner, observationFor };
