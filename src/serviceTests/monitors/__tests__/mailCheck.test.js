'use strict';

// The mail delivery check — the one the whole feature was asked for.
//
// The distinction it exists to make: "the server accepted it" and "it arrived"
// are different facts, and the second one is the one nobody else measures. So
// most of this file is about what happens between acceptance and arrival.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMailCheck } = require('../checks/mail');
const { SmtpError } = require('../smtpClient');

const CONFIG = {
  smtp_host: 'smtp.example.com',
  smtp_port: 587,
  smtp_security: 'starttls',
  smtp_username: 'probe',
  from_address: 'assurance@example.com',
  to_address: 'mailprobe@example.com',
};

// A clock the test drives, so a five-minute deadline costs no real time.
function makeClock(start = 1700000000000) {
  let at = start;
  return {
    now: () => at,
    advance(ms) { at += ms; },
  };
}

function monitor(over = {}) {
  const { config, secrets, ...rest } = over;
  return {
    id: 1, name: 'Customer mail', type: 'mail', target: CONFIG.smtp_host,
    ...rest,
    config: { ...CONFIG, ...(config || {}) },
    secrets: { smtp_password: 'hunter2', imap_password: 'hunter3', ...(secrets || {}) },
  };
}

const sender = (result = {}) => ({
  sent: [],
  async send(opts) {
    this.sent.push(opts);
    return {
      code: 250, response: '2.0.0 Ok: queued as 4bXk2Z', queue_id: '4bXk2Z',
      token: opts.token, message_id: '<x@blueeyes.invalid>',
      timings: { connect: 20, greeting: 5, tls: 40, auth: 30, envelope: 10, data: 60, total: 165 },
      ...result,
    };
  },
});

test('send-only measures acceptance and says so', async () => {
  const smtp = sender();
  const check = createMailCheck({ smtp, imap: { async findToken() { throw new Error('must not look'); } } });
  const result = await check.check(monitor());

  assert.equal(result.status, 'ok');
  assert.equal(result.unit, 'ms');
  assert.equal(result.value, 165);
  assert.equal(result.detail.measured, 'acceptance');
  assert.equal(result.detail.queue_id, '4bXk2Z');
  assert.match(result.summary, /Accepted by smtp\.example\.com/);
  // The token went into the subject, where an IMAP SEARCH can find it.
  assert.match(smtp.sent[0].subject, /BlueEyes assurance probe \[[0-9a-f]{8}\]/);
  assert.equal(smtp.sent[0].password, 'hunter2');
});

test('round-trip measures DELIVERY, from our send to the receiving server\'s own clock', async () => {
  const clock = makeClock();
  const smtp = sender();
  let looks = 0;
  const imap = {
    async findToken() {
      looks += 1;
      // Not there the first two times — which is the normal case for mail.
      if (looks < 3) return { found: false, uid: null, internal_date: null };
      return { found: true, uid: 9, internal_date: new Date(clock.now() - 1000) };
    },
  };
  const check = createMailCheck({
    smtp,
    imap,
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    pollIntervalMs: 5000,
  });
  const result = await check.check(monitor({ config: { roundtrip: true, imap_host: 'imap.example.com', imap_username: 'probe' } }));

  assert.equal(result.status, 'ok');
  assert.equal(result.detail.measured, 'delivery');
  assert.equal(result.detail.attempts, 3);
  assert.equal(result.value, 9000, 'delivery is measured to the INTERNALDATE, not to now');
  assert.equal(result.timings.delivery, 9000);
  assert.match(result.summary, /Delivered to mailprobe@example\.com in 9\.0 s/);
});

test('accepted but never delivered is the finding, not a pass', async () => {
  const clock = makeClock();
  const check = createMailCheck({
    smtp: sender(),
    imap: { async findToken() { return { found: false, uid: null, internal_date: null }; } },
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    pollIntervalMs: 30000,
  });
  const result = await check.check(monitor({
    config: { roundtrip: true, imap_host: 'imap.example.com', imap_username: 'probe', deadline_sec: 120 },
  }));

  assert.equal(result.status, 'failed');
  assert.equal(result.kind, 'mail_undelivered');
  assert.match(result.summary, /accepted the message \(250\) but it never reached/);
  assert.equal(result.detail.waited_sec, 120);
  assert.ok(result.detail.attempts >= 2, 'it kept looking until the deadline');
});

test('a receiving clock that runs behind ours never produces a negative delivery time', async () => {
  const clock = makeClock();
  const check = createMailCheck({
    smtp: sender(),
    imap: {
      async findToken() {
        // The mail server's clock is an hour behind.
        return { found: true, uid: 3, internal_date: new Date(clock.now() - 3600000) };
      },
    },
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
  });
  const result = await check.check(monitor({ config: { roundtrip: true, imap_host: 'imap.example.com', imap_username: 'probe' } }));
  assert.equal(result.status, 'ok');
  assert.ok(result.value >= 0, 'a measurement is never negative');
  assert.equal(result.detail.clock_skew, true, 'and the skew is reported rather than hidden');
});

test('each SMTP phase maps to the verdict an operator can act on', async () => {
  const cases = [
    [new SmtpError('connect ECONNREFUSED', { phase: 'connect' }), 'unreachable', 'monitor_unreachable'],
    [new SmtpError('the TLS handshake failed', { phase: 'tls' }), 'unreachable', 'monitor_unreachable'],
    [new SmtpError('535 auth failed', { phase: 'auth', code: 535 }), 'failed', 'mail_auth_failed'],
    [new SmtpError('550 relay denied', { phase: 'envelope', code: 550 }), 'failed', 'mail_rejected'],
    [new SmtpError('552 message too large', { phase: 'data', code: 552 }), 'failed', 'mail_rejected'],
  ];
  for (const [error, status, kind] of cases) {
    const check = createMailCheck({ smtp: { async send() { throw error; } }, imap: {} });
    const result = await check.check(monitor());
    assert.equal(result.status, status, error.message);
    assert.equal(result.kind, kind, error.message);
    assert.equal(result.detail.phase, error.phase);
  }
});

test('a mailbox we cannot open is OUR problem — misconfigured, never "undelivered"', async () => {
  const clock = makeClock();
  const loginFailure = Object.assign(new Error('Invalid credentials'), { phase: 'login' });
  const check = createMailCheck({
    smtp: sender(),
    imap: { async findToken() { throw loginFailure; } },
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
  });
  const result = await check.check(monitor({ config: { roundtrip: true, imap_host: 'imap.example.com', imap_username: 'probe' } }));
  assert.equal(result.status, 'misconfigured');
  assert.match(result.summary, /could not be opened \(login\)/);
});

test('a monitor missing its own essentials reports misconfigured without sending anything', async () => {
  const smtp = sender();
  const check = createMailCheck({ smtp, imap: {} });
  const noHost = await check.check(monitor({ config: { smtp_host: '' } }));
  assert.equal(noHost.status, 'misconfigured');
  assert.equal(smtp.sent.length, 0, 'nothing was sent');

  const noMailbox = await check.check(monitor({ config: { roundtrip: true, imap_host: '' } }));
  assert.equal(noMailbox.status, 'misconfigured');
  assert.match(noMailbox.summary, /not configured/);
});
