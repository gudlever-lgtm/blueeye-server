'use strict';

// The security-rate rule over device_events
// (src/devices/securityEventDetector.js): a burst of auth.failure /
// acl.denied / port.security_violation / vpn.negotiation_failed from one
// sender becomes a finding, once.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createSecurityEventDetector, loadSecurityEventConfig, parseRules, senderKey, DEFAULT_RULES,
} = require('../src/devices/securityEventDetector');
const { createDeviceEventIngest } = require('../src/devices/deviceEventIngest');

function sink() {
  const emitted = [];
  return { emitted, emit: async (f) => { emitted.push(f); return { ...f, id: f.id || 'stored' }; } };
}

function event(over = {}) {
  return {
    sourceIp: '10.0.0.1',
    receivedAt: '2026-09-30T10:00:00.000Z',
    transport: 'syslog',
    severity: 4,
    eventType: 'auth.failure',
    summary: 'Login failed for admin',
    occurrences: 1,
    deviceId: null,
    snmpDeviceId: null,
    ...over,
  };
}

// A clock the test drives, so a window is exercised without waiting for one.
function clock(startIso) {
  let t = new Date(startIso).getTime();
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

test('stays silent under the threshold and raises exactly once over it', async () => {
  const s = sink();
  const c = clock('2026-09-30T10:00:00Z');
  const d = createSecurityEventDetector({ findingSink: s, config: loadSecurityEventConfig({}), now: c.now });

  // auth.failure warns at 10 in 10 minutes.
  for (let i = 0; i < 9; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await d.observe(7, [event({ receivedAt: new Date(c.now().getTime() - 1000).toISOString() })]);
  }
  assert.equal(s.emitted.length, 0, 'raised under the threshold');

  await d.observe(7, [event({ receivedAt: new Date(c.now().getTime() - 1000).toISOString() })]);
  assert.equal(s.emitted.length, 1);
  const f = s.emitted[0];
  assert.equal(f.metric, 'security.auth_failure');
  assert.equal(f.severity, 'WARN');
  assert.equal(f.kind, 'THRESHOLD');
  assert.equal(f.hostId, '7', 'the finding is keyed to the agent that received the messages');
  assert.equal(f.observed, 10);
  assert.match(f.explanation, /10 × auth\.failure in 10 minutes/);
  assert.match(f.explanation, /does not say why/, 'the explanation claims intent');
  assert.equal(f.evidence[0].labels.threshold, 10);
  assert.equal(f.evidence[0].target, '10.0.0.1');

  // The cooldown holds: more of the same is not a second finding.
  await d.observe(7, [event(), event(), event()]);
  assert.equal(s.emitted.length, 1, 'the cooldown did not hold');
});

test('escalates to CRIT at the crit count, and counts occurrences not rows', async () => {
  const s = sink();
  const d = createSecurityEventDetector({ findingSink: s, config: loadSecurityEventConfig({}) });
  // One folded row standing for 60 sightings crosses the CRIT line (50) alone.
  await d.observe(3, [event({ occurrences: 60 })]);
  assert.equal(s.emitted.length, 1);
  assert.equal(s.emitted[0].severity, 'CRIT');
  assert.equal(s.emitted[0].observed, 60);
});

test('the window slides — sightings older than it do not count', async () => {
  const s = sink();
  const c = clock('2026-09-30T10:00:00Z');
  const d = createSecurityEventDetector({ findingSink: s, config: loadSecurityEventConfig({}), now: c.now });

  await d.observe(1, [event({ occurrences: 9, receivedAt: c.now().toISOString() })]);
  c.advance(11 * 60 * 1000); // past the 10-minute window
  await d.observe(1, [event({ occurrences: 9, receivedAt: c.now().toISOString() })]);
  assert.equal(s.emitted.length, 0, '18 sightings across two windows raised as if they were one');

  await d.observe(1, [event({ occurrences: 2, receivedAt: c.now().toISOString() })]);
  assert.equal(s.emitted.length, 1, '11 sightings inside one window did not raise');
});

test('senders are counted apart, and a switch is not its collector', async () => {
  const s = sink();
  const d = createSecurityEventDetector({ findingSink: s, config: loadSecurityEventConfig({}) });
  await d.observe(1, [event({ occurrences: 9, snmpDeviceId: 4 })]);
  await d.observe(1, [event({ occurrences: 9, snmpDeviceId: 5 })]);
  assert.equal(s.emitted.length, 0, 'two switches were counted as one sender');

  await d.observe(1, [event({ occurrences: 2, snmpDeviceId: 4 })]);
  assert.equal(s.emitted.length, 1);
  assert.equal(s.emitted[0].deviceId, 4, 'the finding did not name the switch');

  // The identity ladder: switch, then agent host, then the bare address.
  assert.equal(senderKey({ snmpDeviceId: 4, deviceId: 9, sourceIp: '1.1.1.1' }), 's4');
  assert.equal(senderKey({ snmpDeviceId: null, deviceId: 9, sourceIp: '1.1.1.1' }), 'd9');
  assert.equal(senderKey({ snmpDeviceId: null, deviceId: null, sourceIp: '1.1.1.1' }), 'ip:1.1.1.1');
});

test('event types with no rule are ignored entirely', async () => {
  const s = sink();
  const d = createSecurityEventDetector({ findingSink: s, config: loadSecurityEventConfig({}) });
  const rows = Array.from({ length: 500 }, () => event({ eventType: 'link.down' }));
  await d.observe(1, rows);
  assert.equal(s.emitted.length, 0);
});

test('off by flag, and off without a licence', async () => {
  const s = sink();
  const off = createSecurityEventDetector({
    findingSink: s, config: loadSecurityEventConfig({ SECURITY_EVENT_ALERTS_ENABLED: 'false' }),
  });
  await off.observe(1, [event({ occurrences: 999 })]);
  assert.equal(s.emitted.length, 0);

  const unlicensed = createSecurityEventDetector({
    findingSink: s, config: loadSecurityEventConfig({}), licensed: () => false,
  });
  await unlicensed.observe(1, [event({ occurrences: 999 })]);
  assert.equal(s.emitted.length, 0);
});

test('a sink that throws never escapes observe()', async () => {
  const d = createSecurityEventDetector({
    findingSink: { emit: async () => { throw new Error('store down'); } },
    config: loadSecurityEventConfig({}),
  });
  const raised = await d.observe(1, [event({ occurrences: 99 })]);
  assert.deepEqual(raised, []);
});

test('SECURITY_EVENT_RULES overrides one rule and leaves the rest', () => {
  const rules = parseRules('auth.failure:5/30/60', DEFAULT_RULES);
  assert.deepEqual(rules['auth.failure'], { metric: 'security.auth_failure', windowMinutes: 60, warn: 5, crit: 30 });
  assert.deepEqual(rules['acl.denied'], DEFAULT_RULES['acl.denied'], 'an unrelated rule was rewritten');

  // A type the server's catalogue has not heard of is still accepted — the
  // agent's classifier ships ahead of it.
  const custom = parseRules('ids.alert:2/5/10', DEFAULT_RULES);
  assert.equal(custom['ids.alert'].metric, 'security.ids_alert');

  // Garbage is dropped, reported, and never takes the table down with it.
  const bad = [];
  const kept = parseRules('auth.failure:nope,acl.denied:9/2/5,,  ', DEFAULT_RULES, (e) => bad.push(e));
  assert.deepEqual(bad, ['auth.failure:nope', 'acl.denied:9/2/5'], 'crit below warn was accepted');
  assert.deepEqual(kept['auth.failure'], DEFAULT_RULES['auth.failure']);
});

test('garbage into observe() never throws', async () => {
  const d = createSecurityEventDetector({ findingSink: sink(), config: loadSecurityEventConfig({}) });
  for (const arg of [undefined, null, 'x', 42, [], [null], [{}], [{ eventType: 'auth.failure' }]]) {
    // eslint-disable-next-line no-await-in-loop
    assert.ok(Array.isArray(await d.observe(1, arg)));
  }
});

test('the ingest calls it after the rows are stored, and a failure there never fails the ingest', async () => {
  const stored = [];
  const seen = [];
  const ingest = createDeviceEventIngest({
    deviceEventsRepo: {
      createMany: async (agentId, rows) => { stored.push(...rows); return { inserted: rows.length, folded: 0 }; },
    },
    agentsRepo: { findAll: async () => [] },
    securityEventDetector: {
      observe: async (agentId, rows) => {
        // The PREPARED rows: the ids the ingest resolved are already on them.
        assert.ok(rows.every((r) => 'snmpDeviceId' in r && 'deviceId' in r));
        seen.push(...rows);
        return [{ id: 'f1' }];
      },
    },
  });
  const out = await ingest.ingest(7, [event()]);
  assert.equal(out.inserted, 1);
  assert.equal(out.securityFindings, 1);
  assert.equal(seen.length, 1);
  assert.equal(stored.length, 1, 'the row was stored before the detector ran');

  const breaking = createDeviceEventIngest({
    deviceEventsRepo: { createMany: async (a, rows) => ({ inserted: rows.length, folded: 0 }) },
    agentsRepo: { findAll: async () => [] },
    securityEventDetector: { observe: async () => { throw new Error('boom'); } },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  });
  const survived = await breaking.ingest(7, [event()]);
  assert.equal(survived.inserted, 1, 'a broken detector took the ingest down with it');
  assert.equal(survived.securityFindings, 0);
});
