'use strict';

const silentLogger = { info() {}, warn() {}, error() {} };

// Lazily builds a nodemailer SMTP transport from config, IF nodemailer is
// installed. Kept lazy so the server has no hard dependency on it (and tests
// never need it — they inject a transport). Point SMTP at a European/self-hosted
// host. Returns null when nodemailer is unavailable or SMTP isn't configured.
function createSmtpTransport(smtp, logger = silentLogger) {
  if (!smtp || !smtp.host) return null;
  let nodemailer;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    nodemailer = require('nodemailer');
  } catch {
    logger.warn('alerting: email enabled but nodemailer is not installed — email channel disabled');
    return null;
  }
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: Boolean(smtp.secure),
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
}

// Email channel. `transport` is anything with sendMail(message) → Promise (a
// nodemailer transport in production, a mock in tests).
function createEmailChannel({ config = {}, transport = null, logger = silentLogger }) {
  async function send(finding, group) {
    if (!transport || typeof transport.sendMail !== 'function') {
      return { ok: false, detail: 'no mail transport configured' };
    }
    if (!config.to) return { ok: false, detail: 'no recipient configured' };

    const subject = `[BlueEye ${finding.severity || 'INFO'}] ${finding.metric || 'finding'} på host ${finding.hostId}`;
    const text = [
      finding.explanation || '',
      '',
      `Host: ${finding.hostId}`,
      `Metric: ${finding.metric}`,
      `Severity: ${finding.severity}`,
      `Kind: ${finding.kind}`,
      finding.deviation != null ? `Afvigelse: ${finding.deviation}` : null,
      group && group.hint ? `\nRoot-cause: ${group.hint}` : null,
    ].filter((x) => x != null).join('\n');

    try {
      await transport.sendMail({ from: config.from, to: config.to, subject, text });
    } catch (err) {
      logger.warn(`alerting: email send failed (${err.message})`);
      return { ok: false, detail: `send failed: ${err.message}` };
    }
    return { ok: true, detail: `sent to ${config.to}` };
  }

  return { name: 'email', send };
}

module.exports = { createEmailChannel, createSmtpTransport };
