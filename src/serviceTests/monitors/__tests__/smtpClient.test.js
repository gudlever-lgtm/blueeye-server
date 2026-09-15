'use strict';

// The SMTP conversation, against a scripted socket.
//
// What is being pinned down: the phase names (they ARE the diagnosis), that a
// multi-line reply assembles rather than restarts, that a refusal carries the
// code the server gave, that STARTTLS is required when asked for, and that a
// password is never written to a socket that has not been upgraded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { createSmtpClient, SmtpError, stuff, queueIdFrom, buildMessage } = require('../smtpClient');

// A socket that answers from a script. Each entry is what the server says NEXT,
// emitted after the client writes. `chunks: true` splits a reply across two data
// events, which is the case a line-buffer gets wrong.
function makeSocket(script, { connectEvent = 'connect', split = false } = {}) {
  const socket = new EventEmitter();
  socket.written = [];
  socket.destroyed = false;
  const queue = script.slice();
  const emit = (text) => {
    if (!split || text.length < 4) {
      socket.emit('data', Buffer.from(text));
      return;
    }
    const at = Math.floor(text.length / 2);
    socket.emit('data', Buffer.from(text.slice(0, at)));
    socket.emit('data', Buffer.from(text.slice(at)));
  };
  socket.write = (data) => {
    socket.written.push(String(data));
    const next = queue.shift();
    if (next !== undefined && next !== null) setImmediate(() => emit(next));
    return true;
  };
  socket.destroy = () => { socket.destroyed = true; };
  // Connect first, THEN the greeting on a later tick — like a real server,
  // where the data event cannot land before the client has a reader attached.
  setImmediate(() => {
    socket.emit(connectEvent);
    setImmediate(() => {
      const greeting = queue.shift();
      if (greeting) emit(greeting);
    });
  });
  return socket;
}

const OK_SCRIPT = [
  '220 mail.example.com ESMTP ready\r\n',        // greeting
  '250-mail.example.com\r\n250-STARTTLS\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n', // EHLO
  '220 ready to start TLS\r\n',                   // STARTTLS
  '250-mail.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n', // EHLO again
  '235 2.7.0 Authentication successful\r\n',      // AUTH
  '250 2.1.0 Ok\r\n',                             // MAIL FROM
  '250 2.1.5 Ok\r\n',                             // RCPT TO
  '354 End data with <CR><LF>.<CR><LF>\r\n',      // DATA
  '250 2.0.0 Ok: queued as 4bXk2Z\r\n',           // the message
];

test('a successful send reports the code, the queue id and a time for every phase', async () => {
  // The script is consumed by the plain socket up to STARTTLS, then by the
  // upgraded one — which is exactly how the real exchange goes.
  const plain = makeSocket(OK_SCRIPT.slice(0, 3));
  const upgraded = new EventEmitter();
  upgraded.written = [];
  upgraded.destroyed = false;
  upgraded.destroy = () => { upgraded.destroyed = true; };
  const rest = OK_SCRIPT.slice(3);
  upgraded.write = (data) => {
    upgraded.written.push(String(data));
    const next = rest.shift();
    if (next) setImmediate(() => upgraded.emit('data', Buffer.from(next)));
    return true;
  };
  const api = createSmtpClient({
    connect: () => plain,
    upgrade: () => { setImmediate(() => upgraded.emit('secureConnect')); return upgraded; },
  });

  const sent = await api.send({
    host: 'mail.example.com', port: 587, security: 'starttls',
    username: 'probe', password: 'hunter2', from: 'a@example.com', to: 'b@example.com',
    token: 'abc123', timeoutMs: 2000,
  });

  assert.equal(sent.code, 250);
  assert.equal(sent.queue_id, '4bXk2Z');
  assert.equal(sent.token, 'abc123');
  for (const phase of ['connect', 'greeting', 'tls', 'auth', 'envelope', 'data', 'total']) {
    assert.ok(Number.isFinite(sent.timings[phase]), `no timing for ${phase}`);
  }
  // The password must not have crossed the plain socket.
  assert.ok(!plain.written.join('').includes('hunter2'));
  assert.ok(upgraded.written.join('').includes('AUTH PLAIN'));
  // And the body carried the token where IMAP can find it.
  const body = upgraded.written.join('');
  assert.match(body, /Subject: .*/);
  assert.match(body, /X-BlueEyes-Probe: abc123/);
  assert.match(body, /\r\n\.\r\n/, 'the message was terminated with a lone dot');
});

test('a multi-line reply split across packets assembles into one reply', async () => {
  const plain = makeSocket([
    '220 ready\r\n',
    '250-one\r\n250-two\r\n250 three\r\n',
    '250 ok\r\n', '250 ok\r\n', '354 go\r\n', '250 ok\r\n',
  ], { split: true });
  const api = createSmtpClient({ connect: () => plain });
  const sent = await api.send({
    host: 'h', port: 25, security: 'none', from: 'a@b.dk', to: 'c@d.dk', timeoutMs: 2000,
  });
  assert.equal(sent.code, 250);
});

test('a refusal carries the phase and the code the server answered with', async () => {
  const plain = makeSocket([
    '220 ready\r\n',
    '250-h\r\n250 HELP\r\n',
    '250 ok\r\n',                       // MAIL FROM
    '550 5.1.1 <c@d.dk>: Recipient address rejected\r\n', // RCPT TO
  ]);
  const api = createSmtpClient({ connect: () => plain });
  await assert.rejects(
    api.send({ host: 'h', port: 25, security: 'none', from: 'a@b.dk', to: 'c@d.dk', timeoutMs: 2000 }),
    (err) => {
      assert.ok(err instanceof SmtpError);
      assert.equal(err.phase, 'envelope');
      assert.equal(err.code, 550);
      assert.match(err.message, /Recipient address rejected/);
      return true;
    }
  );
  assert.ok(plain.destroyed, 'the socket is closed whatever happened');
});

test('STARTTLS that the server does not offer is a tls-phase failure, not a plaintext send', async () => {
  const plain = makeSocket(['220 ready\r\n', '250-h\r\n250 HELP\r\n']);
  const api = createSmtpClient({ connect: () => plain });
  await assert.rejects(
    api.send({ host: 'h', port: 587, security: 'starttls', username: 'u', password: 'p', from: 'a@b.dk', to: 'c@d.dk', timeoutMs: 2000 }),
    (err) => {
      assert.equal(err.phase, 'tls');
      assert.match(err.message, /does not offer STARTTLS/);
      return true;
    }
  );
  assert.ok(!plain.written.join('').includes('AUTH'), 'no credentials were offered');
});

test('a server that accepts the connection and then says nothing times out in the phase it stalled in', async () => {
  const plain = makeSocket([]); // greeting never arrives
  const api = createSmtpClient({ connect: () => plain });
  await assert.rejects(
    api.send({ host: 'h', port: 25, security: 'none', from: 'a@b.dk', to: 'c@d.dk', timeoutMs: 60 }),
    (err) => {
      assert.equal(err.phase, 'greeting');
      assert.match(err.message, /no answer within/);
      return true;
    }
  );
});

test('dot-stuffing protects a body line that would otherwise end the message', () => {
  assert.equal(stuff('.hidden\nvisible'), '..hidden\r\nvisible');
  assert.equal(stuff('a\nb'), 'a\r\nb');
});

test('the queue id is read when the server volunteers one, and null otherwise', () => {
  assert.equal(queueIdFrom('250 2.0.0 Ok: queued as 4bXk2Z'), '4bXk2Z');
  assert.equal(queueIdFrom('250 Ok'), null);
});

test('the probe message says what it is and carries the token twice', () => {
  const message = buildMessage({ from: 'a@b.dk', to: 'c@d.dk', subject: 'probe [tok]', token: 'tok' });
  assert.ok(message.headers.some((h) => h === 'X-BlueEyes-Probe: tok'));
  assert.ok(message.headers.some((h) => h.startsWith('Auto-Submitted: auto-generated')), 'an auto-reply must not answer it');
  assert.match(message.text, /Token: tok/);
  assert.match(message.text, /deleted automatically/);
});
