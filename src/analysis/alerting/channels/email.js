'use strict';

const silentLogger = { info() {}, warn() {}, error() {} };

// Whether the optional `nodemailer` dependency is installed. The email channel
// has no hard dependency on it (keeps the default footprint minimal), so it is
// require()d lazily — this lets the dispatcher SURFACE "email disabled: nodemailer
// not installed" instead of the channel silently failing every send.
function isNodemailerAvailable() {
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    require.resolve('nodemailer');
    return true;
  } catch {
    return false;
  }
}

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
// nodemailer transport in production, a mock in tests). Alternatively pass a
// `createTransport(smtp)` factory: the transport is then built lazily from
// config.smtp and rebuilt whenever those SMTP settings change, so an admin
// editing SMTP at runtime takes effect without a restart. An injected
// `transport` always wins and is never rebuilt (keeps tests deterministic).
function createEmailChannel({ config = {}, transport = null, createTransport = null, logger = silentLogger }) {
  let built = null;
  let builtKey = null;
  const smtpKey = (s) => (s ? `${s.host}|${s.port}|${s.user}|${s.pass}|${s.secure ? 1 : 0}` : '');
  function currentTransport() {
    if (transport) return transport;
    if (typeof createTransport !== 'function') return null;
    const key = smtpKey(config.smtp);
    if (key !== builtKey) { built = createTransport(config.smtp); builtKey = key; }
    return built;
  }

  async function send(finding, group) {
    const tx = currentTransport();
    if (!tx || typeof tx.sendMail !== 'function') {
      return { ok: false, detail: 'no mail transport configured' };
    }
    if (!config.to) return { ok: false, detail: 'no recipient configured' };

    const subject = `[BlueEye ${finding.severity || 'INFO'}] ${finding.metric || 'finding'} on host ${finding.hostId}`;
    const text = [
      finding.explanation || '',
      '',
      `Host: ${finding.hostId}`,
      `Metric: ${finding.metric}`,
      `Severity: ${finding.severity}`,
      `Kind: ${finding.kind}`,
      finding.deviation != null ? `Deviation: ${finding.deviation}` : null,
      group && group.hint ? `\nRoot-cause: ${group.hint}` : null,
    ].filter((x) => x != null).join('\n');

    try {
      await tx.sendMail({ from: config.from, to: config.to, subject, text });
    } catch (err) {
      logger.warn(`alerting: email send failed (${err.message})`);
      return { ok: false, detail: `send failed: ${err.message}` };
    }
    return { ok: true, detail: `sent to ${config.to}` };
  }

  // Reports whether this channel can actually send, so describe() can tell an
  // operator WHY a configured email channel isn't delivering. An injected
  // transport (tests/custom) is always available; otherwise we need nodemailer.
  function status() {
    if (transport) return { available: true };
    if (typeof createTransport === 'function' && !isNodemailerAvailable()) {
      return { available: false, reason: 'nodemailer not installed (npm install nodemailer)' };
    }
    return { available: true };
  }

  return { name: 'email', send, status };
}

module.exports = { createEmailChannel, createSmtpTransport, isNodemailerAvailable };
