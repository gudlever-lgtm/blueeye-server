'use strict';

const silentLogger = { info() {}, warn() {}, error() {} };

// Formats a DATETIME/epoch as an unambiguous UTC string for the email body, so
// the expiry is legible regardless of the recipient's locale.
function formatExpiry(expiresAt) {
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return '';
  // e.g. "2026-07-17 14:30 UTC"
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// Escapes text for safe inclusion in the HTML part (the values come from admin
// input / a generated password, but we never want to emit raw markup).
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Pure renderer for the one-time-password email. Bilingual (Danish first, then
// English) to match BlueEye's da/en convention. The password appears ONLY in the
// message body — never in the login link — per the security requirements.
// Exported so it is unit-testable without a transport.
function renderTempPasswordEmail({ name = '', tempPassword, loginUrl, expiresAt }) {
  const greetingName = name && String(name).trim() ? ` ${String(name).trim()}` : '';
  const expiry = formatExpiry(expiresAt);
  const link = loginUrl || '';

  const subject = 'BlueEye: din adgang / your access';

  const text = [
    `Hej${greetingName},`,
    '',
    'Der er oprettet en BlueEye-konto til dig. Log ind med engangs-adgangskoden',
    'nedenfor. Du bliver bedt om at vælge en ny adgangskode ved første login.',
    '',
    link ? `Login: ${link}` : 'Login: åbn din BlueEye-server i browseren',
    `Engangs-adgangskode: ${tempPassword}`,
    expiry ? `Udløber: ${expiry}` : null,
    '',
    'Del ikke denne adgangskode med andre. Den vises kun i denne ene mail.',
    '',
    '---',
    '',
    `Hi${greetingName},`,
    '',
    'A BlueEye account has been created for you. Sign in with the one-time',
    'password below. You will be asked to choose a new password on first login.',
    '',
    link ? `Login: ${link}` : 'Login: open your BlueEye server in your browser',
    `One-time password: ${tempPassword}`,
    expiry ? `Expires: ${expiry}` : null,
    '',
    'Do not share this password. It is shown only in this single email.',
  ].filter((l) => l != null).join('\n');

  const safePw = escapeHtml(tempPassword);
  const safeLink = escapeHtml(link);
  const safeExpiry = escapeHtml(expiry);
  const safeName = escapeHtml(greetingName);
  const html = [
    `<p>Hej${safeName},</p>`,
    '<p>Der er oprettet en BlueEye-konto til dig. Log ind med engangs-adgangskoden nedenfor. Du bliver bedt om at vælge en ny adgangskode ved første login.</p>',
    '<ul>',
    link ? `<li>Login: <a href="${safeLink}">${safeLink}</a></li>` : '<li>Login: åbn din BlueEye-server i browseren</li>',
    `<li>Engangs-adgangskode: <strong>${safePw}</strong></li>`,
    safeExpiry ? `<li>Udløber: ${safeExpiry}</li>` : '',
    '</ul>',
    '<p>Del ikke denne adgangskode med andre. Den vises kun i denne ene mail.</p>',
    '<hr>',
    `<p>Hi${safeName},</p>`,
    '<p>A BlueEye account has been created for you. Sign in with the one-time password below. You will be asked to choose a new password on first login.</p>',
    '<ul>',
    link ? `<li>Login: <a href="${safeLink}">${safeLink}</a></li>` : '<li>Login: open your BlueEye server in your browser</li>',
    `<li>One-time password: <strong>${safePw}</strong></li>`,
    safeExpiry ? `<li>Expires: ${safeExpiry}</li>` : '',
    '</ul>',
    '<p>Do not share this password. It is shown only in this single email.</p>',
  ].filter(Boolean).join('\n');

  return { subject, text, html };
}

// Sends the one-time-password email when an admin creates (or re-issues a
// password for) a local user. It reuses the SAME SMTP configuration as the
// alerting email channel — `getEmailConfig()` returns the live
// { from, smtp } from the alerting config, so an admin editing SMTP in
// Settings → Alerting takes effect here too, with no separate config.
//
// Injection mirrors the alerting email channel: pass a ready `transport`
// (tests / custom), or a `createTransport(smtp)` factory that builds one lazily
// (production wires createSmtpTransport). sendTempPassword THROWS on any failure
// (no transport, or the send rejects) so the caller can roll back the
// half-created user and answer 500 instead of leaving a user who can never log in.
function createUserMailer({ getEmailConfig = () => ({}), transport = null, createTransport = null, logger = silentLogger }) {
  function currentTransport(smtp) {
    if (transport) return transport;
    if (typeof createTransport === 'function') return createTransport(smtp);
    return null;
  }

  async function sendTempPassword({ to, name, tempPassword, loginUrl, expiresAt }) {
    if (!to) throw new Error('no recipient');
    if (!tempPassword) throw new Error('no password');
    const cfg = getEmailConfig() || {};
    const tx = currentTransport(cfg.smtp);
    if (!tx || typeof tx.sendMail !== 'function') {
      throw new Error('no mail transport configured (set SMTP host in Settings → Alerting)');
    }
    const { subject, text, html } = renderTempPasswordEmail({ name, tempPassword, loginUrl, expiresAt });
    try {
      await tx.sendMail({ from: cfg.from || 'blueeye@localhost', to, subject, text, html });
    } catch (err) {
      logger.warn(`userMailer: temp-password send to ${to} failed (${err.message})`);
      throw err;
    }
    return { ok: true };
  }

  return { sendTempPassword };
}

module.exports = { createUserMailer, renderTempPasswordEmail, formatExpiry };
