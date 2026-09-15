'use strict';

const tls = require('tls');

// A small IMAP client — enough to answer one question: has the probe message
// arrived yet, and when.
//
// Written here for the same reasons as smtpClient.js: no new dependency, and
// what a mail library returns ("here are your messages") is not what this needs
// ("was this token delivered, and at what time did the server receive it").
//
// It speaks LOGIN, SELECT, UID SEARCH, UID FETCH INTERNALDATE, UID STORE and
// EXPUNGE. No IDLE, no partial fetch, no body parsing — a delivery probe never
// reads a message, it only establishes that one is there. That is also a privacy
// decision: BlueEyes connects to a mailbox and must not be able to read mail out
// of it by accident.

const CRLF = '\r\n';

class ImapError extends Error {
  constructor(message, { phase = null, response = null } = {}) {
    super(message);
    this.name = 'ImapError';
    this.phase = phase;
    this.response = response;
  }
}

// IMAP is tagged: every command carries a tag and the response that closes it
// starts with the same tag. Untagged lines ('* SEARCH 4 5') arrive in between
// and carry the data, so both are collected and handed back together.
function createReader(socket) {
  let buffer = '';
  let pending = null;
  let failed = null;

  // The next COMPLETE line, consumed from the buffer. Lines already taken stay
  // taken, so a reply split across TCP segments assembles rather than restarts.
  function nextLine() {
    const i = buffer.indexOf('\n');
    if (i < 0) return null;
    const line = buffer.slice(0, i).replace(/\r$/, '');
    buffer = buffer.slice(i + 1);
    return line;
  }

  function settle() {
    if (!pending) return;
    if (failed) {
      const { reject } = pending;
      pending = null;
      reject(failed);
      return;
    }
    const { tag, untagged } = pending;
    let line = nextLine();
    while (line !== null) {
      untagged.push(line);
      const done = tag === null
        // The greeting is untagged, so the first status line IS the reply.
        ? /^\*\s+(OK|NO|BAD|PREAUTH|BYE)/i.test(line)
        : line.startsWith(`${tag} `);
      if (done) {
        const { resolve } = pending;
        pending = null;
        const status = (line.match(/^\S+\s+(OK|NO|BAD|BYE)/i) || [])[1] || 'OK';
        resolve({ status: status.toUpperCase(), lines: untagged, last: line });
        return;
      }
      line = nextLine();
    }
  }

  function onData(chunk) { buffer += chunk.toString('utf8'); settle(); }
  function onError(err) { failed = err instanceof Error ? err : new Error(String(err)); settle(); }
  function onClose() { onError(new Error('the connection closed')); }

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  socket.on('end', onClose);

  return {
    read(tag) {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        pending = { tag, resolve, reject, untagged: [] };
        settle();
      });
    },
  };
}

function withTimeout(promise, ms, phase) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    // Deliberately NOT unref'd: this timer IS the guarantee that a peer which
    // accepts a connection and then says nothing is reported instead of waited
    // on forever. It is always cleared in the finally below, so it cannot leak.
    timer = setTimeout(() => reject(new ImapError(`no answer within ${ms} ms`, { phase })), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// An IMAP quoted string. Backslash and quote are the only two characters that
// must be escaped; a password containing either is otherwise a silent login
// failure that looks exactly like a wrong password.
const quoted = (s) => `"${String(s === null || s === undefined ? '' : s).replace(/([\\"])/g, '\\$1')}"`;

// The UIDs out of an untagged SEARCH line. '* SEARCH' with nothing after it is
// a valid, empty answer — the message has not arrived yet.
function uidsFrom(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\*\s+SEARCH((?:\s+\d+)*)\s*$/i);
    if (!m) continue;
    for (const n of m[1].trim().split(/\s+/)) {
      if (n) out.push(Number(n));
    }
  }
  return out;
}

// INTERNALDATE is when the SERVER received the message, which is the honest end
// of a delivery measurement — the clock on the machine running this probe is not
// the one that took delivery.
function internalDateFrom(lines) {
  for (const line of lines) {
    const m = line.match(/INTERNALDATE\s+"([^"]+)"/i);
    if (!m) continue;
    const d = new Date(m[1].replace(/^(\d{2})-(\w{3})-(\d{4})\s/, '$1 $2 $3 '));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

// The delivery path, read off the message itself.
//
// Every relay that handled a message prepends a `Received:` header, so the chain
// IS the route it took — the closest thing mail has to a traceroute. They are
// stored newest-first, which is the reverse of the order the message travelled,
// so this reverses them and works out what each leg cost from the timestamps the
// relays stamped themselves.
//
// The times are other people's clocks. A leg computed from two machines that
// disagree can come out negative, and a negative leg is reported as unknown
// rather than as a number nobody should trust.
const HOP_MAX = 25;

// Header folding: a line starting with whitespace continues the one before it.
function unfold(lines) {
  const out = [];
  for (const raw of lines) {
    const line = String(raw).replace(/\r$/, '');
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += ' ' + line.trim();
    else out.push(line);
  }
  return out;
}

function receivedHopsFrom(lines) {
  const headers = unfold(lines)
    .filter((line) => /^Received:/i.test(line.trim()))
    .map((line) => line.trim().replace(/^Received:\s*/i, ''))
    .slice(0, HOP_MAX);

  // Oldest first — the order the message actually travelled.
  const hops = headers.reverse().map((value) => {
    const at = (value.match(/;\s*([^;]+)$/) || [])[1];
    const when = at ? new Date(at.trim()) : null;
    return {
      from: (value.match(/\bfrom\s+([^\s;(]+)/i) || [])[1] || null,
      by: (value.match(/\bby\s+([^\s;(]+)/i) || [])[1] || null,
      with: (value.match(/\bwith\s+([A-Za-z0-9]+)/i) || [])[1] || null,
      id: (value.match(/\bid\s+([^\s;]+)/i) || [])[1] || null,
      at: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
      raw: value.slice(0, 500),
      ms: null,
    };
  });

  for (let i = 1; i < hops.length; i += 1) {
    const previous = hops[i - 1].at ? Date.parse(hops[i - 1].at) : null;
    const current = hops[i].at ? Date.parse(hops[i].at) : null;
    if (previous === null || current === null) continue;
    const delta = current - previous;
    hops[i].ms = delta >= 0 ? delta : null;
  }
  return hops;
}

function createImapClient({ secureConnect = null, now = () => Date.now() } = {}) {
  const open = typeof secureConnect === 'function' ? secureConnect : (opts) => tls.connect(opts);

  // One look in the mailbox. Resolves { found, uid, internal_date, hops, ms } — `found:
  // false` is a normal answer, not an error: the message may simply still be in
  // flight, and the caller decides when to stop asking.
  async function findToken({
    host,
    port = 993,
    username,
    password,
    mailbox = 'INBOX',
    token,
    timeoutMs = 15000,
    cleanup = true,
    rejectUnauthorized = true,
  }) {
    const started = now();
    let socket = null;
    let reader = null;
    let counter = 0;

    const send = async (command, phase, { tolerate = false } = {}) => {
      counter += 1;
      const tag = `a${counter}`;
      socket.write(`${tag} ${command}${CRLF}`);
      const reply = await withTimeout(reader.read(tag), timeoutMs, phase);
      if (reply.status !== 'OK' && !tolerate) {
        throw new ImapError(reply.last || `${phase} failed`, { phase, response: reply.last });
      }
      return reply;
    };

    try {
      socket = open({ host, port, servername: host, rejectUnauthorized, timeout: timeoutMs });
      if (!socket || typeof socket.on !== 'function') throw new ImapError('no socket', { phase: 'connect' });
      await withTimeout(new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', (err) => reject(new ImapError(err && err.message ? err.message : 'connection failed', { phase: 'connect' })));
      }), timeoutMs, 'connect');

      reader = createReader(socket);
      const greeting = await withTimeout(reader.read(null), timeoutMs, 'greeting');
      if (greeting.status !== 'OK' && !/PREAUTH/i.test(greeting.last || '')) {
        throw new ImapError(greeting.last || 'the server refused the connection', { phase: 'greeting', response: greeting.last });
      }

      await send(`LOGIN ${quoted(username)} ${quoted(password)}`, 'login');
      await send(`SELECT ${quoted(mailbox)}`, 'select');

      // The header search is exact. A server that refuses it (some proxies do)
      // falls back to the subject, which carries the same token — a weaker match
      // that is still unique in practice, and better than reporting "not
      // delivered" for a message that is sitting right there.
      let search = await send(`UID SEARCH HEADER X-BlueEyes-Probe ${quoted(token)}`, 'search', { tolerate: true });
      let uids = search.status === 'OK' ? uidsFrom(search.lines) : [];
      if (!uids.length) {
        search = await send(`UID SEARCH SUBJECT ${quoted(token)}`, 'search', { tolerate: true });
        uids = search.status === 'OK' ? uidsFrom(search.lines) : [];
      }

      if (!uids.length) {
        await send('LOGOUT', 'logout', { tolerate: true });
        return { found: false, uid: null, internal_date: null, hops: [], ms: now() - started };
      }

      const uid = uids[uids.length - 1];
      let internalDate = null;
      let hops = [];
      // The Received chain comes back with the date: it is the route the message
      // took and what each leg of it cost, which is the question "where did the
      // time go" actually needs answering. PEEK, so looking does not mark the
      // probe message as read in somebody's mailbox.
      const fetched = await send(`UID FETCH ${uid} (INTERNALDATE BODY.PEEK[HEADER.FIELDS (RECEIVED)])`, 'fetch', { tolerate: true });
      if (fetched.status === 'OK') {
        internalDate = internalDateFrom(fetched.lines);
        hops = receivedHopsFrom(fetched.lines);
      }

      if (cleanup) {
        // Best-effort: a mailbox that will not let us delete is a mailbox we
        // keep measuring anyway. It is reported, not fatal.
        await send(`UID STORE ${uid} +FLAGS (\\Deleted)`, 'cleanup', { tolerate: true });
        await send('EXPUNGE', 'cleanup', { tolerate: true });
      }
      await send('LOGOUT', 'logout', { tolerate: true });
      return { found: true, uid, internal_date: internalDate, hops, ms: now() - started };
    } finally {
      try { if (socket && !socket.destroyed) socket.destroy(); } catch { /* answered already */ }
    }
  }

  return { findToken };
}

// `receivedHopsFrom` is deliberately NOT exported: it is only ever fed the lines
// a FETCH came back with, and the suite drives it through `findToken` over a
// scripted socket — which is the same thing, plus the proof that the command
// asking for those headers is the one actually sent.
module.exports = { createImapClient, uidsFrom, internalDateFrom, quoted };
