'use strict';

const tls = require('tls');
const { denyReason, REASON } = require('../security/hostPolicy');

// TLS certificate inspection — "when does this expire?", asked before it does.
//
// The runner only ever learned about a certificate by tripping over it: a
// scheduled test failed, classify.js said `tls_failure`, and the operator found
// out on the morning the service stopped working. This asks the question on its
// own schedule, so an expiry is a warning weeks early instead of an outage.
//
// It is a HANDSHAKE, not a request: no HTTP is sent, nothing is read from the
// peer, and the socket is destroyed the moment the certificate is in hand. That
// keeps it honest with the module's privacy rule (metadata only) and cheap
// enough to run against every registered address.
//
// `connect` is injected so the suite never touches the network — production
// leaves it unset and gets tls.connect.

const DEFAULT_PORT = 443;
const DEFAULT_TIMEOUT_MS = 10000;

const STATUS = {
  OK: 'ok',
  EXPIRING: 'expiring',
  EXPIRED: 'expired',
  INVALID: 'invalid',
  UNREACHABLE: 'unreachable',
};

// The subset of a base URL this module cares about. Returns null for anything
// that is not https — a plain-http application has no certificate to watch, and
// saying so is more useful than inventing a target on port 443.
function targetFromUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (!host) return null;
  // The same permanent deny-list the rest of the module uses: an address no
  // policy could ever permit is not made reachable by a different code path.
  if (denyReason(host) === REASON.DENIED_ADDRESS) return null;
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, url: url.origin };
}

// Collapses the duplicate targets a set of base URLs produces — an application
// and its production environment usually name the same host, and that is one
// certificate, not two. First occurrence wins, so the application's own address
// keeps its environment attribution.
function targetsFrom(entries = []) {
  const out = new Map();
  for (const entry of entries) {
    const target = targetFromUrl(entry && entry.url);
    if (!target) continue;
    const key = `${target.host}:${target.port}`;
    if (out.has(key)) continue;
    out.set(key, { ...target, environmentId: (entry && entry.environmentId) || null });
  }
  return [...out.values()];
}

// Node hands back a peer certificate with dates as RFC 2822 strings ('Mar 14
// 09:00:00 2027 GMT') and a subject/issuer as objects. This flattens it into the
// columns the table holds, and never throws on a shape it did not expect.
function parsePeerCertificate(cert) {
  const dn = (value) => {
    if (!value || typeof value !== 'object') return null;
    const parts = Object.entries(value)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`);
    return parts.length ? parts.join(', ').slice(0, 512) : null;
  };
  const date = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return {
    subject: dn(cert && cert.subject),
    issuer: dn(cert && cert.issuer),
    serial_number: cert && cert.serialNumber ? String(cert.serialNumber).slice(0, 128) : null,
    fingerprint: cert && (cert.fingerprint256 || cert.fingerprint)
      ? String(cert.fingerprint256 || cert.fingerprint).slice(0, 190)
      : null,
    alt_names: cert && cert.subjectaltname ? String(cert.subjectaltname).slice(0, 2000) : null,
    valid_from: date(cert && cert.valid_from),
    valid_to: date(cert && cert.valid_to),
  };
}

// Whole days from `at` until `validTo`. Floored, so "0 days" means it expires
// today and a negative number is how long it has ALREADY been expired.
function daysUntil(validTo, at) {
  if (!validTo) return null;
  return Math.floor((validTo.getTime() - at.getTime()) / 86400000);
}

// The verdict. Separated from the connection so the thresholds are testable
// without a socket, and so a stored row can be re-judged when an operator
// changes the warning window without re-connecting to anything.
function verdict({ daysRemaining, warnDays = 30, authorized = true, authorizationError = null }) {
  if (!authorized) {
    // An expired certificate fails authorization too. Report the expiry, because
    // "it expired" is the actionable half of "the chain did not verify".
    if (daysRemaining !== null && daysRemaining !== undefined && daysRemaining < 0) return STATUS.EXPIRED;
    if (authorizationError && /expire/i.test(String(authorizationError))) return STATUS.EXPIRED;
    return STATUS.INVALID;
  }
  if (daysRemaining === null || daysRemaining === undefined) return STATUS.INVALID;
  if (daysRemaining < 0) return STATUS.EXPIRED;
  if (daysRemaining <= warnDays) return STATUS.EXPIRING;
  return STATUS.OK;
}

// Opens a TLS connection to one target and reports its certificate.
//
// `rejectUnauthorized: false` is DELIBERATE and is the point of the check: a
// connection that refuses an expired or self-signed certificate would report
// "unreachable" and lose the very fact we came for. The verdict is computed from
// `authorized` / `authorizationError` instead, so nothing is trusted — it is
// inspected and then judged.
function createCertificateChecker({ connect = null, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  const open = typeof connect === 'function' ? connect : tls.connect;

  function check(target, { warnDays = 30 } = {}) {
    const at = now();
    const base = {
      host: target.host,
      port: target.port || DEFAULT_PORT,
      url: target.url || null,
      checked_at: at,
    };

    return new Promise((resolve) => {
      let settled = false;
      const finish = (row) => {
        if (settled) return;
        settled = true;
        try { if (socket && !socket.destroyed) socket.destroy(); } catch { /* the verdict is already made */ }
        resolve(row);
      };
      const unreachable = (message) => finish({
        ...base,
        status: STATUS.UNREACHABLE,
        error_message: String(message || 'no answer').slice(0, 1000),
        subject: null, issuer: null, serial_number: null, fingerprint: null, alt_names: null,
        valid_from: null, valid_to: null, days_remaining: null,
      });

      let socket;
      try {
        socket = open({
          host: base.host,
          port: base.port,
          servername: base.host,
          // See above: we inspect first and judge second.
          rejectUnauthorized: false,
          timeout: timeoutMs,
        });
      } catch (err) {
        return unreachable(err && err.message);
      }
      if (!socket || typeof socket.on !== 'function') return unreachable('no socket');

      socket.on('error', (err) => unreachable(err && err.message));
      socket.on('timeout', () => unreachable(`no answer within ${timeoutMs} ms`));
      socket.on('close', () => unreachable('the connection closed before the handshake finished'));
      socket.on('secureConnect', () => {
        let cert = null;
        try { cert = socket.getPeerCertificate(); } catch { cert = null; }
        if (!cert || !Object.keys(cert).length) return unreachable('the peer presented no certificate');
        const parsed = parsePeerCertificate(cert);
        const daysRemaining = daysUntil(parsed.valid_to, at);
        const authorized = socket.authorized !== false;
        const authorizationError = socket.authorizationError
          ? String(socket.authorizationError.message || socket.authorizationError)
          : null;
        const status = verdict({ daysRemaining, warnDays, authorized, authorizationError });
        return finish({
          ...base,
          ...parsed,
          days_remaining: daysRemaining,
          status,
          error_message: status === STATUS.INVALID || status === STATUS.EXPIRED ? authorizationError : null,
        });
      });
      return undefined;
    });
  }

  return { check };
}

module.exports = {
  createCertificateChecker,
  targetFromUrl,
  targetsFrom,
  parsePeerCertificate,
  daysUntil,
  verdict,
  STATUS,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
};
