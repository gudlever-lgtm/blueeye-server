'use strict';

// The red line at the top: which metrics count as an attack indication, and the
// endpoint every open dashboard polls for it.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  isAttackMetric, ATTACK_METRICS, ATTACK_METRIC_PREFIXES, BANNER_SEVERITIES, BANNER_WINDOW_HOURS,
  CORROBORATION_EXEMPT_SEVERITIES, BAR_SUMMARY_MAX, summarize,
} = require('../src/analysis/attackIndication');
const { metricFamily } = require('../src/changes/indications');
const { makeApp, makeFindingStore, authHeader } = require('../test-support/fakes');

test('the membership list: what is an attack indication and what is not', () => {
  for (const m of ATTACK_METRICS) assert.ok(isAttackMetric(m), `${m} is on the list but does not test as one`);
  for (const m of ['security.auth_failure', 'security.acl_denied', 'security.port_violation', 'SECURITY.AUTH_FAILURE']) {
    assert.ok(isAttackMetric(m), `${m} should match the security. prefix`);
  }
  // A rule an operator adds for an event type this server has not heard of is
  // covered the day it fires, without a code change.
  assert.ok(isAttackMetric('security.ids_alert'));

  // Inventory drift, faults and blanks are not attacks.
  for (const m of ['device.new', 'cpu', 'probe.latency', 'flow.volume', 'l2.loop', 'if.1.in.errPps', '', null, undefined, 42]) {
    assert.equal(isAttackMetric(m), false, `${m} must not read as an attack indication`);
  }
});

test('the changes feed reads the SAME list — one definition, not two', () => {
  for (const m of [...ATTACK_METRICS, 'security.auth_failure', 'security.ids_alert']) {
    assert.equal(metricFamily(m), 'security', `${m} is an attack metric but not in the security family`);
  }
  // And nothing that is not on the list was dragged into the family with it.
  assert.equal(metricFamily('device.new'), null);
  assert.equal(metricFamily('flow.volume'), 'saturation');
  assert.equal(metricFamily('probe.cert'), 'certificate');
});

test('INFO never raises the bar', () => {
  assert.deepEqual(BANNER_SEVERITIES, ['WARN', 'CRIT']);
  assert.equal(BANNER_WINDOW_HOURS, 24);
});

test('CRIT is the only severity that reaches the bar uncorroborated', () => {
  assert.deepEqual(CORROBORATION_EXEMPT_SEVERITIES, ['CRIT']);
});

test('the bar summary is whole sentences, never a sentence cut mid-word', () => {
  const scan = '192.168.1.11 reached 175 distinct ports across 4 distinct hosts '
    + '(internal (RFC1918) destinations) in 15 minutes — over the 50-port threshold. '
    + 'Counted from flow metadata only (5-tuple), so this says what was touched, not what '
    + 'was sent or whether anything answered. A vulnerability scanner, an asset inventory or '
    + 'a backup agent walking the LAN looks the same: if this source is one of yours, add it '
    + 'to SCAN_IGNORE_SOURCES.';
  const out = summarize(scan);
  assert.ok(out.length <= BAR_SUMMARY_MAX, 'the summary does not fit the strip');
  assert.ok(out.endsWith('threshold.'), `the summary stopped mid-sentence: ${out}`);
  // The old behaviour: a hard slice that put "…add it to" on screen.
  assert.ok(!/add it$/.test(out));

  // Short enough already: untouched, and no ellipsis invented.
  assert.equal(summarize('Jitter 32 ms to example.com:443.'), 'Jitter 32 ms to example.com:443.');
  // A dotted address or a version number does not end a sentence.
  assert.match(summarize('10.0.0.5 v1.2 reached 400 ports.'), /^10\.0\.0\.5 v1\.2/);
  // One sentence longer than the cap is cut on a word boundary AND says so.
  const long = `${'word '.repeat(80)}end.`;
  const cut = summarize(long);
  assert.ok(cut.endsWith('…'), 'a cut summary did not say it was cut');
  assert.ok(cut.length <= BAR_SUMMARY_MAX + 1);
  assert.equal(summarize(''), null);
  assert.equal(summarize(null), null);
});

// The shared fake's own attackIndication implementation over these rows — the
// membership and ordering rules are modelled there, so this file exercises the
// route rather than restating the store.
function storeWith(findings) {
  const store = makeFindingStore();
  store.rows.push(...findings);
  return store;
}

// RELATIVE, NOT A DATE IN 2026. A fixed timestamp drops out of the bar's
// 24-hour window as soon as the calendar passes it, and the test then fails on
// a Tuesday for reasons that have nothing to do with the code.
const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

const F = (over = {}) => ({
  id: 'f1', metric: 'net.scan', severity: 'WARN', hostId: '7', eventCaseId: null,
  acked: false, createdAt: new Date().toISOString(), explanation: 'something swept the network', ...over,
});

test('GET /api/findings/attack-indication: 401 without a token, viewer+ with one', async () => {
  const app = makeApp({ findingStore: storeWith([]) });
  assert.equal((await request(app).get('/api/findings/attack-indication')).status, 401);
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.count, 0);
  assert.equal(res.body.worst, null);
  assert.equal(res.body.windowHours, BANNER_WINDOW_HOURS);
});

test('it is NOT read as a finding id — the route order holds', async () => {
  // `/:id/context` is mounted after it; if the order ever flips, this answers
  // 404 for a UUID that does not exist, on the one endpoint every browser polls.
  const app = makeApp({ findingStore: storeWith([]) });
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200, 'attack-indication was matched as an id');
});

test('worst first, then newest, and the one the bar links to is at the head', async () => {
  // The WARNs are corroborated (each shares a case with a finding from another
  // detector); the CRIT needs no corroboration.
  const app = makeApp({
    findingStore: storeWith([
      F({ id: 'warn-old', severity: 'WARN', createdAt: hoursAgo(5), eventCaseId: 1 }),
      F({ id: 'asn-old', metric: 'peer.new_asn', severity: 'INFO', createdAt: hoursAgo(5), eventCaseId: 1 }),
      F({ id: 'crit', metric: 'net.beacon', severity: 'CRIT', createdAt: hoursAgo(3), eventCaseId: 12 }),
      F({ id: 'warn-new', severity: 'WARN', createdAt: hoursAgo(1), eventCaseId: 2 }),
      F({ id: 'dhcp-new', metric: 'probe.dhcp.rogue', severity: 'INFO', createdAt: hoursAgo(1), eventCaseId: 2 }),
    ]),
  });
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 3);
  assert.equal(res.body.worst, 'CRIT');
  assert.equal(res.body.findings[0].id, 'crit', 'a WARN outranked a CRIT on the bar');
  assert.equal(res.body.findings[0].eventCaseId, 12, 'the bar has nothing to link to');
  assert.deepEqual(res.body.bySeverity, { WARN: 2, CRIT: 1 });
});

// RED MEANS "WE ARE REASONABLY SURE". One detector saying "this source touched
// a lot of ports" is a candidate, not a conclusion — the detector's own text
// says a backup agent looks the same — so a WARN waits for a second detector.
test('a lone WARN does not light the bar: corroboration is the rule', async () => {
  const app = makeApp({
    findingStore: storeWith([
      // No event case at all: nothing has agreed with it yet.
      F({ id: 'alone' }),
      // A case, but the only other finding in it is the same detector again.
      F({ id: 'twice-a', eventCaseId: 5 }),
      F({ id: 'twice-b', eventCaseId: 5 }),
      // A case whose other member is not an attack indication.
      F({ id: 'with-fault', eventCaseId: 6 }),
      F({ id: 'fault', metric: 'cpu', severity: 'CRIT', eventCaseId: 6 }),
    ]),
  });
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', authHeader('viewer'));
  assert.equal(res.body.count, 0, 'an uncorroborated WARN lit the red bar');
});

test('a WARN plus a second detector in the same event case does light it', async () => {
  const app = makeApp({
    findingStore: storeWith([
      F({ id: 'scan', metric: 'net.scan', severity: 'WARN', eventCaseId: 9 }),
      // INFO corroborates without being on the bar itself — exactly the shape
      // of a scan next to a first-ever ASN from the same host.
      F({ id: 'asn', metric: 'peer.new_asn', severity: 'INFO', eventCaseId: 9 }),
    ]),
  });
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', authHeader('viewer'));
  assert.equal(res.body.count, 1);
  assert.equal(res.body.findings[0].id, 'scan');
  assert.equal(res.body.findings[0].eventCaseId, 9);
});

test('a CRIT needs no second opinion', async () => {
  const app = makeApp({ findingStore: storeWith([F({ id: 'crit', severity: 'CRIT' })]) });
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', authHeader('viewer'));
  assert.equal(res.body.count, 1);
  assert.equal(res.body.worst, 'CRIT');
});

test('the bar is handed a summary that fits it AND the full explanation', async () => {
  const long = 'A reached 400 distinct ports in 15 minutes — over the 50-port threshold. '
    + 'Counted from flow metadata only (5-tuple), so this says what was touched, not what was sent. '
    + 'A vulnerability scanner, an asset inventory or a backup agent walking the LAN looks the same: '
    + 'if this source is one of yours, add it to SCAN_IGNORE_SOURCES.';
  const app = makeApp({ findingStore: storeWith([F({ id: 'crit', severity: 'CRIT', explanation: long })]) });
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', authHeader('viewer'));
  const top = res.body.findings[0];
  assert.ok(top.summary.length <= BAR_SUMMARY_MAX);
  assert.ok(/[.…]$/.test(top.summary), `the bar was handed a cut-off sentence: ${top.summary}`);
  assert.equal(top.explanation, long, 'the full text did not survive for the page behind the bar');
});

test('an acknowledged finding, an INFO one and a metric that is not an attack are all off the bar', async () => {
  const app = makeApp({
    findingStore: storeWith([
      F({ id: 'acked', acked: true }),
      F({ id: 'info', severity: 'INFO', metric: 'peer.new_asn' }),
      F({ id: 'fault', metric: 'cpu', severity: 'CRIT' }),
      F({ id: 'newdevice', metric: 'device.new', severity: 'WARN' }),
      F({ id: 'old', createdAt: '2020-01-01T00:00:00Z' }),
    ]),
  });
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', authHeader('viewer'));
  assert.equal(res.body.count, 0, 'something that should not raise the bar did');
});

test('a store built before this existed answers "nothing" rather than 500ing the poll', async () => {
  // An older wiring, or a deployment whose store predates the bar.
  const legacy = makeFindingStore();
  delete legacy.attackIndication;
  const app = makeApp({ findingStore: legacy });
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
});

test('the prefix list is what the route sends, so a custom security rule is covered', async () => {
  let asked = null;
  const app = makeApp({
    findingStore: makeFindingStore({ attackIndication: async (args) => { asked = args; return { count: 0, bySeverity: {}, worst: null, findings: [] }; } }),
  });
  await request(app).get('/api/findings/attack-indication').set('Authorization', authHeader('viewer'));
  assert.deepEqual(asked.metrics, ATTACK_METRICS);
  assert.deepEqual(asked.prefixes, ATTACK_METRIC_PREFIXES);
  assert.deepEqual(asked.severities, BANNER_SEVERITIES);
  assert.ok(asked.since instanceof Date);
});
