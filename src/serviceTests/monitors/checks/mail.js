'use strict';

const crypto = require('crypto');
const { createSmtpClient } = require('../smtpClient');
const { createImapClient } = require('../imapClient');
const { ok, failed, unreachable, misconfigured, KIND } = require('../result');

// "Did the mail arrive?" — the question a mail server never answers on its own.
//
// Two depths, and the difference matters:
//
//   send-only   connect → STARTTLS → AUTH → MAIL FROM/RCPT TO/DATA → 250.
//               Proves the server TOOK the message. It does not prove delivery:
//               a full queue, a rewritten alias and a spam filter all accept
//               first and drop later.
//   round-trip  the same send, with a unique token, followed by looking in the
//               destination mailbox over IMAP until the token shows up. This is
//               the measurement — end to end, in seconds, from OUR send to the
//               server's own INTERNALDATE.
//
// The failure vocabulary is deliberately narrow, because the phase it died in is
// the diagnosis:
//   connect/greeting/tls  → unreachable        (nothing to judge)
//   auth                  → mail_auth_failed   (our credentials, our fault)
//   envelope/data 5xx     → mail_rejected      (the server said no, and why)
//   accepted, never seen  → mail_undelivered   (the silent one this exists for)

const DEFAULT_POLL_MS = 10000;

const sleeper = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Which verdict an SMTP failure deserves. A 4xx is a temporary refusal and still
// means the mail did not go — it is reported as rejected with its code, not
// softened into "unreachable", because "we could not send" is the operator's
// answer either way and the code says which kind.
function classifySmtpError(err) {
  const phase = (err && err.phase) || null;
  const code = (err && err.code) || null;
  const message = (err && err.message) || 'the send failed';
  // The conversation up to the failure. A phase name says where it stopped; the
  // transcript says what the server actually answered, which is the difference
  // between "auth failed" and "550 5.7.1 sender address rejected".
  const transcript = (err && Array.isArray(err.transcript) && err.transcript.length) ? err.transcript : null;
  const detail = { phase, code, transcript };
  if (phase === 'connect' || phase === 'greeting' || phase === 'tls') {
    return unreachable({ summary: `Could not reach the mail server (${phase}): ${message}`, error: message, detail });
  }
  if (phase === 'auth') {
    return failed(KIND.MAIL_AUTH_FAILED, {
      summary: `The mail server refused the credentials: ${message}`,
      error: message,
      detail,
    });
  }
  return failed(KIND.MAIL_REJECTED, {
    summary: code ? `The mail server refused the message (${code}): ${message}` : `The mail server refused the message: ${message}`,
    error: message,
    detail,
  });
}

function createMailCheck({ smtp = null, imap = null, sleep = sleeper, now = () => Date.now(), pollIntervalMs = DEFAULT_POLL_MS } = {}) {
  const smtpClient = smtp || createSmtpClient({ now });
  const imapClient = imap || createImapClient({ now });

  async function check(monitor) {
    const cfg = monitor.config || {};
    const secrets = monitor.secrets || {};
    if (!cfg.smtp_host || !cfg.from_address || !cfg.to_address) {
      return misconfigured({ summary: 'The monitor is missing the mail server, the sender or the recipient.' });
    }
    const token = crypto.randomBytes(4).toString('hex');
    const subject = `${cfg.subject_prefix || 'BlueEyes assurance probe'} [${token}]`;
    const sentAt = now();

    let sent;
    try {
      sent = await smtpClient.send({
        host: cfg.smtp_host,
        port: cfg.smtp_port || 587,
        security: cfg.smtp_security || 'starttls',
        username: cfg.smtp_username || null,
        password: secrets.smtp_password || null,
        from: cfg.from_address,
        to: cfg.to_address,
        subject,
        token,
        timeoutMs: cfg.timeout_ms || 20000,
      });
    } catch (err) {
      return classifySmtpError(err);
    }

    const acceptMs = (sent.timings && sent.timings.total) || (now() - sentAt);
    const baseDetail = {
      smtp_code: sent.code,
      smtp_response: sent.response,
      queue_id: sent.queue_id,
      message_id: sent.message_id,
      token,
      recipient: cfg.to_address,
      transcript: sent.transcript || null,
    };

    // ------------------------------------------------------------ send only
    if (!cfg.roundtrip) {
      return ok({
        summary: `Accepted by ${cfg.smtp_host} in ${Math.round(acceptMs)} ms (${sent.code}).`,
        value: acceptMs,
        unit: 'ms',
        durationMs: acceptMs,
        timings: sent.timings,
        detail: { ...baseDetail, measured: 'acceptance' },
      });
    }

    // ------------------------------------------------------------ round trip
    if (!cfg.imap_host || !cfg.imap_username) {
      return misconfigured({
        summary: 'Round-trip is on, but the mailbox to look in is not configured.',
        detail: baseDetail,
      });
    }
    const deadlineMs = Math.max(10, Number(cfg.deadline_sec) || 300) * 1000;
    const until = sentAt + deadlineMs;
    let attempts = 0;
    let lastError = null;
    // Every look in the mailbox, with the second it happened at. A message that
    // turned up on the fourth poll and one that never turned up at all look the
    // same in a total; the polls are how an operator tells them apart.
    const polls = [];
    const poll = (entry) => { if (polls.length < 40) polls.push(entry); };

    // Poll rather than IDLE: one connection per look, closed each time. A probe
    // that holds an IMAP session open for five minutes is a probe that shows up
    // as a stuck client in somebody's mail server.
    for (;;) {
      attempts += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const found = await imapClient.findToken({
          host: cfg.imap_host,
          port: cfg.imap_port || 993,
          username: cfg.imap_username,
          password: secrets.imap_password || null,
          mailbox: cfg.imap_mailbox || 'INBOX',
          token,
          cleanup: cfg.cleanup !== false,
          timeoutMs: cfg.timeout_ms || 15000,
        });
        poll({ at: Math.round((now() - sentAt) / 1000), found: !!(found && found.found), ms: found ? found.ms : null });
        if (found && found.found) {
          // INTERNALDATE is the receiving server's own clock, so it is the
          // honest end of the measurement — but only when it is sane. A server
          // whose clock is behind ours would otherwise report a NEGATIVE
          // delivery time, and a negative measurement is worse than a coarse
          // one.
          const arrivedAt = found.internal_date ? found.internal_date.getTime() : now();
          const deliveryMs = arrivedAt >= sentAt ? arrivedAt - sentAt : now() - sentAt;
          return ok({
            summary: `Delivered to ${cfg.to_address} in ${(deliveryMs / 1000).toFixed(1)} s (accepted in ${Math.round(acceptMs)} ms).`,
            value: deliveryMs,
            unit: 'ms',
            durationMs: deliveryMs,
            timings: { ...(sent.timings || {}), delivery: deliveryMs },
            detail: {
              ...baseDetail,
              measured: 'delivery',
              attempts,
              mailbox: cfg.imap_mailbox || 'INBOX',
              internal_date: found.internal_date ? found.internal_date.toISOString() : null,
              clock_skew: found.internal_date && found.internal_date.getTime() < sentAt,
              polls,
              // The route the message took, read off its own Received headers:
              // which relay handed it to which, and what each leg cost.
              hops: Array.isArray(found.hops) ? found.hops : [],
            },
          });
        }
      } catch (err) {
        // A mailbox we cannot open is OUR configuration, not their delivery —
        // reported as such rather than as an undelivered message, which would
        // page somebody about a working mail system.
        lastError = (err && err.message) || String(err);
        poll({ at: Math.round((now() - sentAt) / 1000), found: false, error: lastError });
        if (err && (err.phase === 'login' || err.phase === 'select')) {
          return misconfigured({
            summary: `The probe mailbox could not be opened (${err.phase}): ${lastError}`,
            error: lastError,
            detail: { ...baseDetail, attempts, polls },
          });
        }
      }
      if (now() >= until) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(pollIntervalMs, Math.max(0, until - now())));
      if (now() >= until) break;
    }

    const waited = Math.round((now() - sentAt) / 1000);
    return failed(KIND.MAIL_UNDELIVERED, {
      summary: `${cfg.smtp_host} accepted the message (${sent.code}) but it never reached ${cfg.to_address} — ${waited} s waited.`,
      value: now() - sentAt,
      unit: 'ms',
      durationMs: now() - sentAt,
      timings: sent.timings,
      error: lastError,
      detail: { ...baseDetail, measured: 'delivery', attempts, waited_sec: waited, polls },
    });
  }

  return { check };
}

module.exports = { createMailCheck };
