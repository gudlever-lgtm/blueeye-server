'use strict';

const { numOrNull } = require('../../storage/shape');
const { createCertificateChecker, STATUS: CERT_STATUS } = require('../../assurance/certificates');
const { ok, failed, unreachable, KIND } = require('../result');

// "When does the certificate on THAT port expire?"
//
// The certificate watcher in assurance/certificates.js covers an application's
// own https address, which is the one everybody remembers. The ones that take a
// service down on a Sunday are the others: submission on 465, IMAPS on 993,
// LDAPS on 636, a database with TLS required, an RDP gateway. They expire on the
// same schedule and nobody has a renewal reminder for them.
//
// The handshake itself is the existing checker — the same code, the same
// "inspect first, judge second" rule — so a certificate is read exactly one way
// in this product. This wrapper only takes it to an arbitrary port and turns the
// verdict into a monitor result.

function createTlsPortCheck({ checker = null, now = () => Date.now() } = {}) {
  async function check(monitor) {
    const cfg = monitor.config || {};
    const host = cfg.host;
    const port = cfg.port || 443;
    // numOrNull, not Number(): `Number(null)` is 0, so a monitor with no warning
    // window would warn zero days ahead — i.e. never, which is the opposite of
    // what an unset field should mean.
    const warnDays = numOrNull(cfg.warn_days) === null ? 30 : numOrNull(cfg.warn_days);
    const criticalDays = numOrNull(cfg.critical_days) === null ? 7 : numOrNull(cfg.critical_days);
    const use = checker || createCertificateChecker({ timeoutMs: cfg.timeout_ms || 10000, now: () => new Date(now()) });

    const cert = await use.check({ host, port, url: null }, { warnDays });
    const days = cert.days_remaining;
    const detail = {
      host,
      port,
      subject: cert.subject,
      issuer: cert.issuer,
      valid_to: cert.valid_to ? new Date(cert.valid_to).toISOString() : null,
      days_remaining: days,
      status: cert.status,
    };

    if (cert.status === CERT_STATUS.UNREACHABLE) {
      return unreachable({
        summary: `No TLS handshake with ${host}:${port}${cert.error_message ? ` (${cert.error_message})` : ''}.`,
        error: cert.error_message,
        detail,
      });
    }
    if (cert.status === CERT_STATUS.EXPIRED) {
      return failed(KIND.TLS_EXPIRED, {
        summary: Number.isFinite(days)
          ? `The certificate on ${host}:${port} expired ${Math.abs(days)} day(s) ago.`
          : `The certificate on ${host}:${port} has expired.`,
        value: Number.isFinite(days) ? days : null,
        unit: 'days',
        detail,
      });
    }
    if (cert.status === CERT_STATUS.INVALID) {
      return failed(KIND.TLS_INVALID, {
        summary: `The certificate on ${host}:${port} did not verify${cert.error_message ? ` (${cert.error_message})` : ''}.`,
        error: cert.error_message,
        value: Number.isFinite(days) ? days : null,
        unit: 'days',
        detail,
      });
    }
    // Expiry is a DEADLINE, not a fault: the service works today. It is reported
    // as failed only inside the warning window, and policy.js is what decides
    // whether that is a WARN or a CRIT from the days remaining.
    if (Number.isFinite(days) && days <= warnDays) {
      return failed(KIND.TLS_EXPIRING, {
        summary: days === 0
          ? `The certificate on ${host}:${port} expires today.`
          : `The certificate on ${host}:${port} expires in ${days} day(s).`,
        value: days,
        unit: 'days',
        detail: { ...detail, critical_days: criticalDays },
      });
    }
    return ok({
      summary: `The certificate on ${host}:${port} is valid for another ${days} day(s).`,
      value: Number.isFinite(days) ? days : null,
      unit: 'days',
      detail,
    });
  }

  return { check };
}

module.exports = { createTlsPortCheck };
