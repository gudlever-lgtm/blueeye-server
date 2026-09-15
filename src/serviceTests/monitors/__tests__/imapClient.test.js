'use strict';

// The IMAP side of the round trip, against a scripted socket.
//
// The question it answers is narrow — "is the token in the mailbox, and when did
// the server receive it" — and the things that can go wrong are narrower still:
// a login that fails is OUR configuration, an empty SEARCH is a message still in
// flight, and a password with a quote in it must not silently become a wrong
// password.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { createImapClient, uidsFrom, internalDateFrom, quoted } = require('../imapClient');

// Answers each written command with the next scripted reply. The greeting lands
// one tick after the handshake, like a real server's.
function makeSocket(script) {
  const socket = new EventEmitter();
  socket.written = [];
  socket.destroyed = false;
  const queue = script.slice();
  socket.write = (data) => {
    socket.written.push(String(data));
    const next = queue.shift();
    if (next !== undefined && next !== null) {
      // The reply carries the tag the client used, so the script does not have
      // to know the counter.
      const tag = String(data).split(' ')[0];
      setImmediate(() => socket.emit('data', Buffer.from(next.replace(/%TAG%/g, tag))));
    }
    return true;
  };
  socket.destroy = () => { socket.destroyed = true; };
  setImmediate(() => {
    socket.emit('secureConnect');
    setImmediate(() => {
      const greeting = queue.shift();
      if (greeting) socket.emit('data', Buffer.from(greeting));
    });
  });
  return socket;
}

const LOGIN_OK = [
  '* OK [CAPABILITY IMAP4rev1] ready\r\n',
  '%TAG% OK LOGIN completed\r\n',
  '%TAG% OK [READ-WRITE] SELECT completed\r\n',
];

test('a delivered message is found, with the time the server received it', async () => {
  const socket = makeSocket([
    ...LOGIN_OK,
    '* SEARCH 41\r\n%TAG% OK SEARCH completed\r\n',
    '* 3 FETCH (UID 41 INTERNALDATE "15-Sep-2026 15:04:05 +0200")\r\n%TAG% OK FETCH completed\r\n',
    '%TAG% OK STORE completed\r\n',
    '* 3 EXPUNGE\r\n%TAG% OK EXPUNGE completed\r\n',
    '%TAG% OK LOGOUT\r\n',
  ]);
  const api = createImapClient({ secureConnect: () => socket });
  const found = await api.findToken({ host: 'imap.example.com', username: 'probe', password: 'pw', token: 'abc123', timeoutMs: 2000 });

  assert.equal(found.found, true);
  assert.equal(found.uid, 41);
  assert.ok(found.internal_date instanceof Date);
  assert.equal(found.internal_date.toISOString(), '2026-09-15T13:04:05.000Z');

  const conversation = socket.written.join('');
  assert.match(conversation, /UID SEARCH HEADER X-BlueEyes-Probe "abc123"/);
  assert.match(conversation, /\+FLAGS \(\\Deleted\)/, 'the probe message cleans up after itself');
  assert.match(conversation, /EXPUNGE/);
  assert.ok(socket.destroyed, 'the connection is closed');
});

test('a message that has not arrived is a normal answer, not an error', async () => {
  const socket = makeSocket([
    ...LOGIN_OK,
    '* SEARCH\r\n%TAG% OK SEARCH completed\r\n',
    '* SEARCH\r\n%TAG% OK SEARCH completed\r\n',
    '%TAG% OK LOGOUT\r\n',
  ]);
  const api = createImapClient({ secureConnect: () => socket });
  const found = await api.findToken({ host: 'h', username: 'u', password: 'p', token: 'tok', timeoutMs: 2000 });
  assert.equal(found.found, false);
  assert.equal(found.uid, null);
  // The header search came first and the subject search was the fallback.
  assert.match(socket.written.join(''), /UID SEARCH SUBJECT "tok"/);
});

test('a refused login fails in the login phase — that is our configuration, not their delivery', async () => {
  const socket = makeSocket([
    '* OK ready\r\n',
    '%TAG% NO [AUTHENTICATIONFAILED] Invalid credentials\r\n',
  ]);
  const api = createImapClient({ secureConnect: () => socket });
  await assert.rejects(
    api.findToken({ host: 'h', username: 'u', password: 'wrong', token: 'tok', timeoutMs: 2000 }),
    (err) => {
      assert.equal(err.phase, 'login');
      assert.match(err.message, /Invalid credentials/);
      return true;
    }
  );
});

test('cleanup can be turned off, and then nothing is deleted', async () => {
  const socket = makeSocket([
    ...LOGIN_OK,
    '* SEARCH 7\r\n%TAG% OK SEARCH completed\r\n',
    '* 1 FETCH (UID 7 INTERNALDATE "15-Sep-2026 10:00:00 +0000")\r\n%TAG% OK FETCH completed\r\n',
    '%TAG% OK LOGOUT\r\n',
  ]);
  const api = createImapClient({ secureConnect: () => socket });
  const found = await api.findToken({ host: 'h', username: 'u', password: 'p', token: 'tok', cleanup: false, timeoutMs: 2000 });
  assert.equal(found.found, true);
  assert.ok(!socket.written.join('').includes('+FLAGS'));
});

test('a mailbox that goes silent times out in the phase it stalled in', async () => {
  const socket = makeSocket(['* OK ready\r\n']); // LOGIN is never answered
  const api = createImapClient({ secureConnect: () => socket });
  await assert.rejects(
    api.findToken({ host: 'h', username: 'u', password: 'p', token: 'tok', timeoutMs: 60 }),
    (err) => {
      assert.equal(err.phase, 'login');
      return true;
    }
  );
});

test('quoting escapes what would otherwise break the command', () => {
  assert.equal(quoted('simple'), '"simple"');
  assert.equal(quoted('he said "hi"'), '"he said \\"hi\\""');
  assert.equal(quoted('back\\slash'), '"back\\\\slash"');
  assert.equal(quoted(null), '""');
});

test('SEARCH parsing tells "no results" apart from "no answer"', () => {
  assert.deepEqual(uidsFrom(['* SEARCH 1 2 3', 'a1 OK']), [1, 2, 3]);
  assert.deepEqual(uidsFrom(['* SEARCH', 'a1 OK']), []);
  assert.deepEqual(uidsFrom(['a1 OK']), []);
});

test('INTERNALDATE is read from the FETCH, and a malformed one is null rather than wrong', () => {
  assert.equal(internalDateFrom(['* 1 FETCH (UID 4 INTERNALDATE "15-Sep-2026 15:04:05 +0200")']).toISOString(), '2026-09-15T13:04:05.000Z');
  assert.equal(internalDateFrom(['* 1 FETCH (UID 4 INTERNALDATE "not a date")']), null);
  assert.equal(internalDateFrom(['a1 OK']), null);
});

// --------------------------------------------------------- the delivery path
//
// Every relay that touched the message prepended a `Received:` header, so the
// chain is the route it took — mail's own traceroute. It is stored newest-first
// and written by clocks we do not own, which is where both of the interesting
// bugs live.
test('the Received chain is read back as the route the message travelled', async () => {
  const headers = [
    'Received: from mx.migadu.com (mx.migadu.com [1.2.3.4])',
    '\tby mail.dulmens.dk (Postfix) with ESMTPS id DDD',
    '\tfor <gud@dulmens.dk>; Tue, 15 Sep 2026 19:20:21 +0000',
    'Received: from smtp.migadu.com (smtp.migadu.com [5.6.7.8])',
    '\tby mx.migadu.com (Postfix) with ESMTP id CCC; Tue, 15 Sep 2026 19:20:17 +0000',
  ].join('\r\n');
  const socket = makeSocket([
    ...LOGIN_OK,
    '* SEARCH 41\r\n%TAG% OK SEARCH completed\r\n',
    `* 3 FETCH (UID 41 INTERNALDATE "15-Sep-2026 21:20:21 +0200" BODY[HEADER.FIELDS (RECEIVED)] {${headers.length}}\r\n${headers}\r\n)\r\n%TAG% OK FETCH completed\r\n`,
    '%TAG% OK STORE completed\r\n',
    '* 3 EXPUNGE\r\n%TAG% OK EXPUNGE completed\r\n',
    '%TAG% OK LOGOUT\r\n',
  ]);
  const api = createImapClient({ secureConnect: () => socket });
  const found = await api.findToken({ host: 'imap.example.com', username: 'probe', password: 'pw', token: 'abc123', timeoutMs: 2000 });

  assert.equal(found.found, true);
  // Asked for with PEEK: looking at the probe message must not mark it read in
  // somebody's mailbox.
  assert.match(socket.written.join(''), /BODY\.PEEK\[HEADER\.FIELDS \(RECEIVED\)\]/);

  // Oldest first — the order it travelled, not the order it is stored.
  assert.equal(found.hops.length, 2);
  assert.equal(found.hops[0].by, 'mx.migadu.com');
  assert.equal(found.hops[0].from, 'smtp.migadu.com');
  assert.equal(found.hops[1].by, 'mail.dulmens.dk');
  assert.equal(found.hops[1].with, 'ESMTPS');
  // And what the leg between them cost: 19:20:17 → 19:20:21.
  assert.equal(found.hops[0].ms, null, 'the first hop has nothing to be measured from');
  assert.equal(found.hops[1].ms, 4000);
});

test('a leg computed from two disagreeing clocks is unknown, never negative', async () => {
  const headers = [
    'Received: from a.example (a.example [1.1.1.1]) by b.example with ESMTP id B; Tue, 15 Sep 2026 19:20:10 +0000',
    'Received: from c.example (c.example [2.2.2.2]) by a.example with ESMTP id A; Tue, 15 Sep 2026 19:20:30 +0000',
  ].join('\r\n');
  const socket = makeSocket([
    ...LOGIN_OK,
    '* SEARCH 9\r\n%TAG% OK SEARCH completed\r\n',
    `* 1 FETCH (UID 9 INTERNALDATE "15-Sep-2026 21:20:10 +0200" BODY[HEADER.FIELDS (RECEIVED)] {${headers.length}}\r\n${headers}\r\n)\r\n%TAG% OK FETCH completed\r\n`,
    '%TAG% OK STORE completed\r\n',
    '* 1 EXPUNGE\r\n%TAG% OK EXPUNGE completed\r\n',
    '%TAG% OK LOGOUT\r\n',
  ]);
  const api = createImapClient({ secureConnect: () => socket });
  const found = await api.findToken({ host: 'imap.example.com', username: 'probe', password: 'pw', token: 'abc', timeoutMs: 2000 });
  assert.equal(found.hops.length, 2);
  // a.example stamped 19:20:30, b.example stamped 19:20:10 afterwards. One of
  // them is wrong, and "-20 s in transit" is not an answer.
  assert.equal(found.hops[1].ms, null);
});

test('a message with no Received headers is still a delivery, with no path', async () => {
  const socket = makeSocket([
    ...LOGIN_OK,
    '* SEARCH 5\r\n%TAG% OK SEARCH completed\r\n',
    '* 1 FETCH (UID 5 INTERNALDATE "15-Sep-2026 21:20:10 +0200")\r\n%TAG% OK FETCH completed\r\n',
    '%TAG% OK STORE completed\r\n',
    '* 1 EXPUNGE\r\n%TAG% OK EXPUNGE completed\r\n',
    '%TAG% OK LOGOUT\r\n',
  ]);
  const api = createImapClient({ secureConnect: () => socket });
  const found = await api.findToken({ host: 'imap.example.com', username: 'probe', password: 'pw', token: 'abc', timeoutMs: 2000 });
  assert.equal(found.found, true);
  assert.deepEqual(found.hops, []);
});
