'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createWebhookChannel } = require('../channels/webhook');
const { createSyslogChannel, rfc5424 } = require('../channels/syslog');
const { createEmailChannel } = require('../channels/email');

// ---- webhook ---------------------------------------------------------------
test('webhook signs the JSON payload with HMAC-SHA256', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200 }; };
  const ch = createWebhookChannel({ config: { url: 'https://hook/x', secret: 'topsecret' }, fetchImpl });
  const r = await ch.send({ id: 'f1', hostId: '9', metric: 'cpu', severity: 'CRIT' }, null);
  assert.equal(r.ok, true);
  const expected = `sha256=${crypto.createHmac('sha256', 'topsecret').update(captured.opts.body).digest('hex')}`;
  assert.equal(captured.opts.headers['X-BlueEye-Signature'], expected);
  assert.equal(JSON.parse(captured.opts.body).finding.metric, 'cpu');
});

test('webhook reports a non-OK status and a missing url', async () => {
  const bad = createWebhookChannel({ config: { url: 'https://h/x' }, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal((await bad.send({ hostId: '9', metric: 'cpu', severity: 'CRIT' })).ok, false);
  const none = createWebhookChannel({ config: {} });
  assert.equal((await none.send({})).ok, false);
});

// ---- syslog ----------------------------------------------------------------
test('rfc5424 maps severity to PRI and formats the line', () => {
  const line = rfc5424({ hostId: '9', metric: 'cpu', severity: 'CRIT', kind: 'ANOMALY', explanation: 'high', createdAt: new Date('2026-01-01T00:00:00Z') }, { appName: 'blueeye' });
  // CRIT -> severity 3, facility local0 (16) -> PRI = 16*8+3 = 131
  assert.match(line, /^<131>1 2026-01-01T00:00:00\.000Z 9 blueeye - finding - /);
  assert.match(line, /cpu severity=CRIT/);
});

test('syslog channel sends via the injected sender (WARN -> 132)', async () => {
  const sent = [];
  const ch = createSyslogChannel({ config: { host: 'log', port: 514, proto: 'udp', appName: 'blueeye' }, send: async (buf, dst) => { sent.push({ line: buf.toString(), dst }); } });
  const r = await ch.send({ hostId: '9', metric: 'cpu', severity: 'WARN', createdAt: new Date('2026-01-01T00:00:00Z') });
  assert.equal(r.ok, true);
  assert.equal(sent[0].dst.host, 'log');
  assert.match(sent[0].line, /^<132>1 /); // WARN -> 4 -> PRI 132
});

test('syslog with no host fails cleanly', async () => {
  assert.equal((await createSyslogChannel({ config: {} }).send({})).ok, false);
});

// ---- email -----------------------------------------------------------------
test('email sends via the injected transport', async () => {
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); } };
  const ch = createEmailChannel({ config: { from: 'a@b', to: 'ops@b' }, transport });
  const r = await ch.send({ hostId: '9', metric: 'cpu', severity: 'CRIT', explanation: 'high', kind: 'ANOMALY' });
  assert.equal(r.ok, true);
  assert.equal(sent[0].to, 'ops@b');
  assert.match(sent[0].subject, /BlueEye CRIT/);
});

test('email without a transport or recipient fails cleanly', async () => {
  assert.equal((await createEmailChannel({ config: { to: 'x' } }).send({})).ok, false);
  assert.equal((await createEmailChannel({ config: {}, transport: { sendMail: async () => {} } }).send({})).ok, false);
});

test('channel status() surfaces availability for describe()', () => {
  // Injected transport is always available; webhook/syslog (built-ins) too.
  assert.deepEqual(createEmailChannel({ config: {}, transport: { sendMail: async () => {} } }).status(), { available: true });
  assert.equal(createWebhookChannel({ config: {} }).status().available, true);
  assert.equal(createSyslogChannel({ config: {} }).status().available, true);
  // With a createTransport factory but no nodemailer installed, email reports why.
  const st = createEmailChannel({ config: {}, createTransport: () => null }).status();
  // In a default install nodemailer is absent → unavailable with a reason; if it
  // happens to be installed, available with no reason. Assert the shape holds.
  if (st.available === false) assert.match(st.reason, /nodemailer/);
  else assert.equal(st.available, true);
});

test('email builds its transport lazily from createTransport and rebuilds when SMTP changes', async () => {
  const config = { to: 'ops@b', from: 'a@b', smtp: { host: 'mail1', port: 587, user: '', pass: '', secure: false } };
  const builds = []; const sent = [];
  const ch = createEmailChannel({ config, createTransport: (smtp) => { builds.push({ ...smtp }); return smtp && smtp.host ? { sendMail: async (m) => { sent.push(m); } } : null; } });

  assert.equal((await ch.send({ hostId: '9', metric: 'cpu', severity: 'CRIT' })).ok, true);
  assert.equal(builds.length, 1); // built once
  await ch.send({ hostId: '9', metric: 'cpu', severity: 'CRIT' });
  assert.equal(builds.length, 1); // same SMTP -> cached, no rebuild
  config.smtp = { host: 'mail2', port: 587, user: '', pass: '', secure: false }; // changed
  await ch.send({ hostId: '9', metric: 'cpu', severity: 'CRIT' });
  assert.equal(builds.length, 2); // rebuilt
  assert.equal(sent.length, 3);
});
