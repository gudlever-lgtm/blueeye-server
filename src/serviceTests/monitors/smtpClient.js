'use strict';

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

// A small SMTP client, written here rather than taken from a library.
//
// Two reasons, and the second is the real one:
//
//   1. No new dependency. The alerting channel's nodemailer is optional and may
//      not be installed; a monitor that cannot run because a dependency is
//      missing is a monitor that answers "misconfigured" forever.
//   2. A library reports "sent" or "threw". This check exists to measure WHERE
//      the time went — a mail server that accepts in 4 seconds has a different
//      problem from one that authenticates in 4 seconds — and per-phase timings
//      are not something a send() helper hands back.
//
// It speaks the subset that a delivery probe needs: EHLO, STARTTLS, AUTH
// PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA, QUIT. It is not a mail library: no
// attachments, no pipelining, no 8BITMIME negotiation, no retry. If the peer
// wants anything else, the probe reports what it said and stops.
//
// Sockets are injected so the suite never opens one.

const CRLF = '\r\n';

// Everything the caller learns about a failed exchange: which phase it died in,
// what the server said, and the code it said it with. The phase is the
// diagnosis — "auth" and "data" are different outages.
class SmtpError extends Error {
  constructor(message, { phase = null, code = null, response = null } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.phase = phase;
    this.code = code;
    this.response = response;
  }
}

// Reads SMTP replies off a socket. A reply is one or more lines; the last one
// has a space after the code ("250-STARTTLS" … "250 HELP"), and everything
// before it is a continuation. Anything the peer sends before we ask for it is
// kept, so a greeting that arrives while we are still setting up is not lost.
function createReader(socket) {
  let buffer = '';
  // Lines of the reply being assembled. Kept across calls: a continuation that
  // arrives in its own TCP segment must not restart the reply.
  let collected = [];
  let pending = null;
  let failed = null;

  // The next COMPLETE line, consumed from the buffer. A trailing fragment stays
  // in the buffer until its newline arrives.
  function nextLine() {
    const i = buffer.indexOf('\n');
    if (i < 0) return null;
    const line = buffer.slice(0, i).replace(/\r$/, '');
    buffer = buffer.slice(i + 1);
    return line;
  }

  function takeReply() {
    let line = nextLine();
    while (line !== null) {
      collected.push(line);
      const m = line.match(/^(\d{3})([ -]?)(.*)$/);
      // A terminator ('250 OK') ends the reply; a continuation ('250-STARTTLS')
      // does not. A line that is not a reply line at all ends it too, with code
      // 0 — better a refused verdict than waiting for a terminator that the peer
      // is never going to send.
      if (!m || m[2] !== '-') {
        const reply = { code: m ? Number(m[1]) : 0, text: collected.join('\n') };
        collected = [];
        return reply;
      }
      line = nextLine();
    }
    return null;
  }

  function settle() {
    if (!pending) return;
    if (failed) {
      const { reject } = pending;
      pending = null;
      reject(failed);
      return;
    }
    const reply = takeReply();
    if (!reply) return;
    const { resolve } = pending;
    pending = null;
    resolve(reply);
  }

  function onData(chunk) { buffer += chunk.toString('utf8'); settle(); }
  function onError(err) { failed = err instanceof Error ? err : new Error(String(err)); settle(); }
  function onClose() { onError(new Error('the connection closed')); }

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  socket.on('end', onClose);

  return {
    read() {
      if (failed) return Promise.reject(failed);
      const ready = takeReply();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    },
    // Detaches before a STARTTLS upgrade: the TLS socket is a new stream and
    // the old listeners would double-report its close.
    detach() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('end', onClose);
      const rest = buffer;
      buffer = '';
      return rest;
    },
  };
}

// Wraps a promise in a deadline. A mail server that accepts the connection and
// then says nothing is the exact failure this check exists to catch, so every
// wait is bounded and the phase is named in the error.
function withTimeout(promise, ms, phase) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    // Deliberately NOT unref'd: this timer IS the guarantee that a peer which
    // accepts a connection and then says nothing is reported instead of waited
    // on forever. It is always cleared in the finally below, so it cannot leak.
    timer = setTimeout(() => reject(new SmtpError(`no answer within ${ms} ms`, { phase })), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// Dot-stuffing (RFC 5321 §4.5.2): a line consisting of a single '.' ends DATA,
// so a body line that starts with one gets a second. Skipping this is how a
// probe message truncates itself the day someone puts a '.' at the start of a
// line.
const stuff = (body) => String(body).replace(/\r?\n/g, CRLF).replace(/^\./gm, '..');

// Builds the probe message. The token goes in the subject AND in a header:
// the subject is what an IMAP SEARCH matches on, the header is what a human
// reading the mailbox uses to tell the probe apart from real mail.
function buildMessage({ from, to, subject, token, date = new Date(), body = null, messageId = null }) {
  const id = messageId || `<${token}.${date.getTime()}@blueeyes.invalid>`;
  const text = body || [
    'This is an automated Service Assurance delivery probe from BlueEyes.',
    '',
    `Token: ${token}`,
    `Sent: ${date.toISOString()}`,
    '',
    'It measures whether mail from this server reaches the mailbox, and how long',
    'that takes. Nothing needs to be done with it; it is deleted automatically',
    'when the probe finds it.',
  ].join('\n');
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${id}`,
    `X-BlueEyes-Probe: ${token}`,
    'Auto-Submitted: auto-generated',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  return { headers, text, messageId: id };
}

// A queue id, when the server volunteered one ("250 2.0.0 Ok: queued as 4bXk2").
// Best-effort: it is evidence for a human chasing the message through a mail
// log, never something the verdict depends on.
function queueIdFrom(response) {
  const m = String(response || '').match(/queued as ([A-Za-z0-9._-]+)|id=([A-Za-z0-9._-]+)|^2\d\d[ -]([A-Z0-9]{8,})/m);
  return (m && (m[1] || m[2] || m[3])) || null;
}

function createSmtpClient({ connect = null, secureConnect = null, upgrade = null, now = () => Date.now() } = {}) {
  const openPlain = typeof connect === 'function' ? connect : (opts) => net.connect(opts);
  const openSecure = typeof secureConnect === 'function' ? secureConnect : (opts) => tls.connect(opts);
  const startTls = typeof upgrade === 'function' ? upgrade : (socket, opts) => tls.connect({ socket, ...opts });

  // Sends one message and reports what each phase cost.
  //
  // Resolves with { code, response, queueId, token, messageId, timings } on a
  // 250, and rejects with an SmtpError carrying the phase otherwise. Never
  // leaves a socket open: QUIT is best-effort, destroy is not.
  async function send({
    host,
    port = 587,
    security = 'starttls',
    username = null,
    password = null,
    from,
    to,
    subject = 'BlueEyes assurance probe',
    token = crypto.randomBytes(4).toString('hex'),
    body = null,
    timeoutMs = 20000,
    servername = null,
    rejectUnauthorized = true,
  }) {
    const started = now();
    const timings = {};
    const mark = (phase, from0) => { timings[phase] = Math.max(0, now() - from0); };

    let socket = null;
    let reader = null;
    let quit = null;

    const say = async (line, phase, expect) => {
      const at = now();
      socket.write(line + CRLF);
      const reply = await withTimeout(reader.read(), timeoutMs, phase);
      if (expect && !expect.includes(Math.floor(reply.code / 100))) {
        throw new SmtpError(reply.text || `unexpected ${reply.code}`, { phase, code: reply.code, response: reply.text });
      }
      return { ...reply, ms: now() - at };
    };

    try {
      // -------------------------------------------------------------- connect
      const connectAt = now();
      const opts = { host, port, timeout: timeoutMs };
      socket = security === 'tls'
        ? openSecure({ ...opts, servername: servername || host, rejectUnauthorized })
        : openPlain(opts);
      if (!socket || typeof socket.on !== 'function') throw new SmtpError('no socket', { phase: 'connect' });
      await withTimeout(new Promise((resolve, reject) => {
        const ok = () => resolve();
        socket.once(security === 'tls' ? 'secureConnect' : 'connect', ok);
        socket.once('error', (err) => reject(new SmtpError(err && err.message ? err.message : 'connection failed', { phase: 'connect' })));
      }), timeoutMs, 'connect');
      mark('connect', connectAt);

      reader = createReader(socket);

      // ------------------------------------------------------------- greeting
      const greetAt = now();
      const greeting = await withTimeout(reader.read(), timeoutMs, 'greeting');
      if (Math.floor(greeting.code / 100) !== 2) {
        throw new SmtpError(greeting.text || 'the server refused the connection', { phase: 'greeting', code: greeting.code, response: greeting.text });
      }
      mark('greeting', greetAt);

      // ----------------------------------------------------------------- ehlo
      const me = 'blueeyes.assurance';
      let ehlo = await say(`EHLO ${me}`, 'ehlo', [2]);
      let capabilities = String(ehlo.text || '').toUpperCase();

      // -------------------------------------------------------------- starttls
      if (security === 'starttls') {
        if (!capabilities.includes('STARTTLS')) {
          throw new SmtpError('the server does not offer STARTTLS', { phase: 'tls', code: ehlo.code, response: ehlo.text });
        }
        const tlsAt = now();
        await say('STARTTLS', 'tls', [2]);
        reader.detach();
        const plain = socket;
        socket = startTls(plain, { servername: servername || host, rejectUnauthorized });
        await withTimeout(new Promise((resolve, reject) => {
          socket.once('secureConnect', resolve);
          socket.once('error', (err) => reject(new SmtpError(err && err.message ? err.message : 'the TLS handshake failed', { phase: 'tls' })));
        }), timeoutMs, 'tls');
        reader = createReader(socket);
        mark('tls', tlsAt);
        // RFC 3207: everything the server said before the upgrade is discarded,
        // so the capabilities are asked for again rather than assumed.
        ehlo = await say(`EHLO ${me}`, 'ehlo', [2]);
        capabilities = String(ehlo.text || '').toUpperCase();
      }

      // ----------------------------------------------------------------- auth
      if (username) {
        const authAt = now();
        if (capabilities.includes('AUTH') && capabilities.includes('PLAIN')) {
          await say(`AUTH PLAIN ${b64(`\0${username}\0${password || ''}`)}`, 'auth', [2]);
        } else if (capabilities.includes('AUTH') && capabilities.includes('LOGIN')) {
          await say('AUTH LOGIN', 'auth', [3]);
          await say(b64(username), 'auth', [3]);
          await say(b64(password || ''), 'auth', [2]);
        } else {
          throw new SmtpError('the server offers no authentication method this probe can use', { phase: 'auth', response: ehlo.text });
        }
        mark('auth', authAt);
      }

      // ------------------------------------------------------------- envelope
      const envAt = now();
      await say(`MAIL FROM:<${from}>`, 'envelope', [2]);
      await say(`RCPT TO:<${to}>`, 'envelope', [2]);
      mark('envelope', envAt);

      // ----------------------------------------------------------------- data
      const dataAt = now();
      await say('DATA', 'data', [3]);
      const message = buildMessage({ from, to, subject, token, date: new Date(), body });
      socket.write(`${message.headers.join(CRLF)}${CRLF}${CRLF}${stuff(message.text)}${CRLF}.${CRLF}`);
      const accepted = await withTimeout(reader.read(), timeoutMs, 'data');
      if (Math.floor(accepted.code / 100) !== 2) {
        throw new SmtpError(accepted.text || `the server refused the message (${accepted.code})`, {
          phase: 'data', code: accepted.code, response: accepted.text,
        });
      }
      mark('data', dataAt);
      timings.total = Math.max(0, now() - started);

      quit = true;
      return {
        code: accepted.code,
        response: String(accepted.text || '').slice(0, 500),
        queue_id: queueIdFrom(accepted.text),
        token,
        message_id: message.messageId,
        timings,
      };
    } finally {
      try {
        if (socket && !socket.destroyed) {
          if (quit) socket.write(`QUIT${CRLF}`);
          socket.destroy();
        }
      } catch { /* the verdict is already made */ }
    }
  }

  return { send };
}

module.exports = { createSmtpClient, SmtpError, buildMessage, queueIdFrom, stuff, createReader };
