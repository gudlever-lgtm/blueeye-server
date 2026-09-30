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

// The shared fake's own attackIndication implementation over these rows — the
// membership and ordering rules are modelled there, so this file exercises the
// route rather than restating the store.
function storeWith(findings) {
  const store = makeFindingStore();
  store.rows.push(...findings);
  return store;
}

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
  const app = makeApp({
    findingStore: storeWith([
      F({ id: 'warn-old', severity: 'WARN', createdAt: '2026-09-30T08:00:00Z' }),
      F({ id: 'crit', metric: 'net.beacon', severity: 'CRIT', createdAt: '2026-09-30T09:00:00Z', eventCaseId: 12 }),
      F({ id: 'warn-new', severity: 'WARN', createdAt: '2026-09-30T10:00:00Z' }),
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
