'use strict';

// Sends a rendered report to its recipients as an attachment.
//
// Delivery reuses the alerting SMTP settings (Settings → Alerting), like the
// one-time-password mail does, so an administrator configures a mail server
// once for the whole product. The transport is built lazily through the
// injected factory, so editing SMTP at runtime takes effect without a restart,
// and tests inject a transport with a sendMail() and assert on what was sent.

const silentLogger = { info() {}, warn() {}, error() {} };

function createReportMailer({ getEmailConfig, createTransport = null, transport = null, logger = silentLogger }) {
  let built = null;
  let builtKey = null;
  const smtpKey = (s) => (s ? `${s.host}|${s.port}|${s.user}|${s.pass}|${s.secure ? 1 : 0}` : '');

  function currentTransport(smtp) {
    if (transport) return transport;
    if (typeof createTransport !== 'function') return null;
    const key = smtpKey(smtp);
    if (key !== builtKey) { built = createTransport(smtp); builtKey = key; }
    return built;
  }

  // Returns { ok, detail } rather than throwing: a failed send is a status on
  // the schedule, not a crashed job that takes the next one with it.
  async function send({ to, subject, text, filename, contentType, body }) {
    const cfg = (typeof getEmailConfig === 'function' ? getEmailConfig() : null) || {};
    const tx = currentTransport(cfg.smtp);
    if (!tx || typeof tx.sendMail !== 'function') return { ok: false, detail: 'no mail transport configured' };
    if (!Array.isArray(to) || to.length === 0) return { ok: false, detail: 'no recipients' };
    try {
      await tx.sendMail({
        from: cfg.from,
        to: to.join(', '),
        subject,
        text,
        attachments: [{ filename, content: body, contentType }],
      });
      return { ok: true, detail: `sent to ${to.length} recipient(s)` };
    } catch (err) {
      logger.warn(`report mail failed: ${err.message}`);
      return { ok: false, detail: `mail failed: ${err.message}` };
    }
  }

  return { send };
}

module.exports = { createReportMailer };
