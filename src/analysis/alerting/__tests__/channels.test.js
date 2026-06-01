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
