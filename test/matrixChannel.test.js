'use strict';

// The Matrix alert channel.
//
// Alerting had email, webhook and syslog. Email is where alerts go to be
// missed, a webhook needs somebody to build the receiving end, and syslog is
// for machines — none of them put the alert in front of the people who fix it.
// Matrix does, and unlike Slack or Teams it can run on the customer's own
// homeserver, which is the only kind of chat an on-prem, EU, no-US-vendors
// product can ship.
//
// Nothing here touches the network: fetch is injected, as it is for the webhook
// channel.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMatrixChannel, renderMessage, txnIdFor } = require('../src/analysis/alerting/channels/matrix');
const { createDispatcher } = require('../src/analysis/alerting/dispatcher');
const { loadAlertingConfig } = require('../src/analysis/alerting/config');

const CONFIG = {
  homeserver: 'https://matrix.example.dk',
  roomId: '!ops:example.dk',
  accessToken: 'syt_secret',
};

const FINDING = {
  id: 42, hostId: 7, metric: 'latency', kind: 'spike', severity: 'CRIT',
  explanation: 'Median latency tripled (28ms → 91ms) over 3 samples.',
  createdAt: '2026-09-20T09:00:00.000Z',
};

// Records the calls and answers 200 unless told otherwise.
function recorder({ ok = true, status = 200, body = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('a finding is posted to the room as an m.room.message with both bodies', async () => {
  const { calls, fetchImpl } = recorder();
  const ch = createMatrixChannel({ config: CONFIG, fetchImpl });

  const res = await ch.send(FINDING, null);

  assert.equal(res.ok, true);
  assert.match(res.detail, /!ops:example\.dk/);
  assert.equal(calls.length, 1);

  const [call] = calls;
  assert.equal(call.init.method, 'PUT');
  assert.match(call.url, /^https:\/\/matrix\.example\.dk\/_matrix\/client\/v3\/rooms\//);
  assert.match(call.url, /%21ops%3Aexample\.dk/, 'the room id must be URL-encoded');
  assert.match(call.url, /\/send\/m\.room\.message\//);
  assert.equal(call.init.headers.Authorization, 'Bearer syt_secret');

  const sent = JSON.parse(call.init.body);
  assert.equal(sent.msgtype, 'm.text');
  assert.equal(sent.format, 'org.matrix.custom.html');
  // The plain body is not a truncated version — every notification preview and
  // plenty of clients show only that one.
  assert.match(sent.body, /CRIT/);
  assert.match(sent.body, /latency/);
  assert.match(sent.body, /host 7/);
  assert.match(sent.body, /Median latency tripled/);
  assert.match(sent.formatted_body, /<b>/);
  assert.match(sent.formatted_body, /Median latency tripled/);
});

test('it PUTs with a transaction id, so a retry cannot post the same alert twice', async () => {
  const { calls, fetchImpl } = recorder();
  const ch = createMatrixChannel({ config: CONFIG, fetchImpl });

  await ch.send(FINDING, null);
  await ch.send(FINDING, null); // the same alert again, e.g. after a timeout

  assert.equal(calls[0].url, calls[1].url, 'the same finding must reuse its transaction id');
  // A DIFFERENT finding is a different transaction.
  await ch.send({ ...FINDING, id: 43 }, null);
  assert.notEqual(calls[2].url, calls[0].url);
  // ...and so is an escalation of the same one, because a WARN that became a
  // CRIT is a thing people need to see.
  await ch.send({ ...FINDING, severity: 'WARN' }, null);
  assert.notEqual(calls[3].url, calls[0].url);
});

test('a cluster alert reads as a cluster, and carries the advisory', async () => {
  const { calls, fetchImpl } = recorder();
  const ch = createMatrixChannel({ config: CONFIG, fetchImpl });

  await ch.send({ ...FINDING, memberCount: 12 }, {
    memberFindingIds: [1, 2, 3], likelyCause: 'upstream link', hint: 'check the uplink',
    advisory: '12 findings on 4 hosts share this cause.',
  });

  const sent = JSON.parse(calls[0].init.body);
  assert.match(sent.body, /12 related findings/);
  assert.match(sent.body, /Likely cause: upstream link/);
  assert.match(sent.body, /12 findings on 4 hosts/);
  assert.doesNotMatch(sent.body, /latency on host 7/, 'a cluster is not one metric on one host');
});

test('HTML in a finding cannot break out of the formatted body', async () => {
  const { calls, fetchImpl } = recorder();
  const ch = createMatrixChannel({ config: CONFIG, fetchImpl });

  await ch.send({ ...FINDING, explanation: '<img src=x onerror="alert(1)"> & "quoted"' }, null);

  const sent = JSON.parse(calls[0].init.body);
  assert.doesNotMatch(sent.formatted_body, /<img/, 'a tag from a finding reached the room as markup');
  assert.match(sent.formatted_body, /&lt;img/);
  assert.match(sent.formatted_body, /&amp;/);
  // The plain body is plain text; it needs no escaping and must not be mangled.
  assert.match(sent.body, /<img src=x/);
});

test('an unconfigured channel says which piece is missing rather than failing opaquely', async () => {
  const { fetchImpl } = recorder();
  const missing = [
    [{}, /homeserver/],
    [{ homeserver: 'https://m.example.dk' }, /room/],
    [{ homeserver: 'https://m.example.dk', roomId: '!r:example.dk' }, /access token/],
  ];
  for (const [config, expected] of missing) {
    const res = await createMatrixChannel({ config, fetchImpl }).send(FINDING, null);
    assert.equal(res.ok, false);
    assert.match(res.detail, expected);
  }
});

test("a homeserver error reports the Matrix errcode, not just the status", async () => {
  // M_FORBIDDEN means the bot is not in the room; M_UNKNOWN_TOKEN means the
  // token expired. "403" alone would send an operator off to look that up.
  const { fetchImpl } = recorder({ ok: false, status: 403, body: { errcode: 'M_FORBIDDEN', error: 'not in room' } });
  const res = await createMatrixChannel({ config: CONFIG, fetchImpl }).send(FINDING, null);
  assert.equal(res.ok, false);
  assert.match(res.detail, /403/);
  assert.match(res.detail, /M_FORBIDDEN/);
});

test('a non-JSON error body is still reported, not thrown', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
  const res = await createMatrixChannel({ config: CONFIG, fetchImpl }).send(FINDING, null);
  assert.equal(res.ok, false);
  assert.match(res.detail, /502/);
});

test('a network failure is a failed send, never a thrown error into the dispatcher', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const res = await createMatrixChannel({ config: CONFIG, fetchImpl }).send(FINDING, null);
  assert.equal(res.ok, false);
  assert.match(res.detail, /ECONNREFUSED/);
});

test('the request does not follow redirects — the access token must not travel to another host', async () => {
  const { calls, fetchImpl } = recorder();
  await createMatrixChannel({ config: CONFIG, fetchImpl }).send(FINDING, null);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('a trailing slash on the homeserver does not produce a double slash', async () => {
  const { calls, fetchImpl } = recorder();
  await createMatrixChannel({ config: { ...CONFIG, homeserver: 'https://matrix.example.dk/' }, fetchImpl }).send(FINDING, null);
  assert.doesNotMatch(calls[0].url, /dk\/\/_matrix/);
});

// ------------------------------------------------------------ in the dispatcher

test('the dispatcher routes to Matrix under the same severity and licence rules as the others', async () => {
  const { calls, fetchImpl } = recorder();
  const matrix = createMatrixChannel({ config: CONFIG, fetchImpl });
  const config = {
    enabled: true,
    cooldownMs: 0,
    channels: { matrix: { enabled: true, minSeverity: 'WARN' } },
  };

  const d = createDispatcher({ config, channels: { matrix } });
  const crit = await d.dispatch(FINDING, null);
  assert.ok(crit.results.some((r) => r.channel === 'matrix' && r.ok), 'a CRIT did not reach the room');

  const info = await d.dispatch({ ...FINDING, id: 99, severity: 'INFO' }, null);
  const matrixResult = info.results.find((r) => r.channel === 'matrix');
  assert.equal(matrixResult.ok, false);
  assert.equal(matrixResult.skipped, true);
  assert.match(matrixResult.detail, /below minSeverity/);

  // An unlicensed channel is skipped, not attempted.
  const unlicensed = createDispatcher({ config, channels: { matrix }, channelLicensed: (n) => n !== 'matrix' });
  const out = await unlicensed.dispatch({ ...FINDING, id: 100 }, null);
  assert.match(out.results.find((r) => r.channel === 'matrix').detail, /not licensed/);
});

test('a failing Matrix send never stops the other channels', async () => {
  const boom = { name: 'matrix', send: async () => { throw new Error('homeserver down'); }, status: () => ({ available: true }) };
  const sent = [];
  const syslog = { name: 'syslog', send: async () => { sent.push('syslog'); return { ok: true }; }, status: () => ({ available: true }) };
  const d = createDispatcher({
    config: { enabled: true, cooldownMs: 0, channels: { matrix: { enabled: true, minSeverity: 'INFO' }, syslog: { enabled: true, minSeverity: 'INFO' } } },
    channels: { matrix: boom, syslog },
  });

  const out = await d.dispatch(FINDING, null);
  assert.deepEqual(sent, ['syslog'], 'syslog did not run after matrix threw');
  assert.match(out.results.find((r) => r.channel === 'matrix').detail, /threw: homeserver down/);
});

// -------------------------------------------------------------------- config

test('the channel is off by default and reads its settings from the environment', () => {
  const off = loadAlertingConfig({});
  assert.equal(off.channels.matrix.enabled, false);
  assert.equal(off.channels.matrix.minSeverity, 'WARN', 'INFO in a room is how a room gets muted');

  const on = loadAlertingConfig({
    ALERT_MATRIX_ENABLED: 'true',
    ALERT_MATRIX_MIN_SEVERITY: 'crit',
    MATRIX_HOMESERVER: 'https://matrix.example.dk',
    MATRIX_ROOM_ID: '!ops:example.dk',
    MATRIX_ACCESS_TOKEN: 'syt_x',
  });
  assert.equal(on.channels.matrix.enabled, true);
  assert.equal(on.channels.matrix.minSeverity, 'CRIT');
  assert.equal(on.channels.matrix.roomId, '!ops:example.dk');
});

test('renderMessage and txnIdFor survive a half-empty finding without throwing', () => {
  for (const f of [{}, { severity: 'WARN' }, { hostId: 0, metric: '' }]) {
    const m = renderMessage(f, null);
    assert.equal(typeof m.body, 'string');
    assert.ok(m.body.length > 0);
    assert.match(txnIdFor(f, null), /^blueeye-[0-9a-f]{32}$/);
  }
});
