'use strict';

// The dead-agent vs network-down verdict (src/health/agentOffline.js). Pure:
// every fact is passed in, so each rung of the evidence ladder is tested on
// its own, and so is "unknown" — the answer when the data is not there.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  assessAgentOffline, VERDICT, VERDICT_CODES, VERDICT_SUMMARY, CHECK,
} = require('../src/health/agentOffline');

const NOW = Date.parse('2026-09-23T10:00:00.000Z');
const SINCE = NOW - 7 * 60 * 1000;
const agent = { id: 7, hostname: 'edge-7', status: 'offline' };
const peers = (...statuses) => ({
  locationId: 3, locationName: 'Aarhus', peers: statuses.map((status, i) => ({ id: 100 + i, name: `peer-${i}`, status })),
});
const probes = (...oks) => ({
  targets: ['10.0.0.7'],
  rows: oks.map((ok, i) => ({ agentId: 200 + i, agentName: `p${i}`, type: 'ping', target: '10.0.0.7', ok, ts: new Date(NOW - 60000).toISOString() })),
});
const checkOf = (r, name) => r.checks.find((c) => c.check === name);

test('with no evidence at all the verdict is unknown, and every check says why', () => {
  const r = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE });
  assert.equal(r.verdict, VERDICT.UNKNOWN);
  assert.equal(r.confidence, 'low');
  assert.equal(r.checks.length, 4);
  for (const c of r.checks) {
    assert.equal(c.result, 'unknown');
    assert.ok(c.detail && c.detail.length > 10, `${c.check} must explain its unknown`);
  }
  assert.match(r.explanation, /edge-7 has been offline for 7 min/);
  assert.match(r.explanation, /Checks \(0 of 4 had data\)/);
});

test('all other agents at the site offline → site/uplink outage (CRIT)', () => {
  const r = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE, site: peers('offline', 'offline') });
  assert.equal(r.verdict, VERDICT.SITE_OUTAGE);
  assert.equal(r.severity, 'CRIT');
  assert.equal(checkOf(r, CHECK.SITE).result, 'all_offline');
  assert.match(r.explanation, /site power or uplink outage/);
});

test('site peers online and nothing else known → the host or its access link', () => {
  const r = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE, site: peers('online', 'offline') });
  assert.equal(r.verdict, VERDICT.HOST_OR_ACCESS_LINK);
  assert.equal(r.severity, 'WARN');
  assert.match(checkOf(r, CHECK.SITE).detail, /1 of 2 other agents at site "Aarhus" is online/);
});

test('other agents still reach the host → the agent process is down', () => {
  const r = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE, site: peers('online'), probes: probes(true, false) });
  assert.equal(r.verdict, VERDICT.AGENT_PROCESS_DOWN);
  assert.equal(checkOf(r, CHECK.PEER_PROBES).result, 'reachable');
  assert.match(r.explanation, /agent process or service has stopped/);
});

test('the newest probe per (prober, target) is the vote — an older success does not outvote a fresh failure', () => {
  const p = {
    targets: ['10.0.0.7'],
    rows: [
      { agentId: 1, type: 'ping', target: '10.0.0.7', ok: true, ts: new Date(NOW - 300000).toISOString() },
      { agentId: 1, type: 'ping', target: '10.0.0.7', ok: false, ts: new Date(NOW - 30000).toISOString() },
    ],
  };
  const r = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE, site: peers('online'), probes: p });
  assert.equal(checkOf(r, CHECK.PEER_PROBES).result, 'unreachable');
  assert.equal(r.verdict, VERDICT.HOST_UNREACHABLE);
  assert.match(r.explanation, /Other agents at the site are online but cannot reach the host/);
});

test('no addresses reported → probe check is unknown, not "unreachable"', () => {
  const r = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE, probes: { targets: [], rows: [] } });
  assert.equal(checkOf(r, CHECK.PEER_PROBES).result, 'unknown');
});

test('a switch port that is down (fresh poll) is the strongest evidence and wins over the site', () => {
  const port = {
    deviceId: 5, deviceName: 'sw-a', ifName: 'Gi1/0/7', mac: 'aa:bb:cc:dd:ee:07',
    operStatus: 'down', adminStatus: 'up', polledAt: new Date(NOW - 30000).toISOString(),
  };
  const r = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE, site: peers('offline'), port });
  assert.equal(r.verdict, VERDICT.SWITCH_PORT_DOWN);
  assert.equal(r.confidence, 'high');
  assert.match(checkOf(r, CHECK.SWITCH_PORT).detail, /sw-a\/Gi1\/0\/7/);
  assert.match(r.explanation, /switch port the host is plugged into is down \(sw-a\/Gi1\/0\/7\)/);
});

test('a link.down trap marks the port down even before the next poll', () => {
  const port = {
    deviceId: 5, deviceName: 'sw-a', ifName: 'Gi1/0/7', operStatus: 'up',
    polledAt: new Date(SINCE - 60000).toISOString(), linkDownAt: new Date(SINCE + 1000).toISOString(),
  };
  const r = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE, port });
  assert.equal(checkOf(r, CHECK.SWITCH_PORT).result, 'down');
  assert.match(checkOf(r, CHECK.SWITCH_PORT).detail, /link\.down reported/);
});

test('a port status that predates the outage is unknown, not "up"', () => {
  const port = { deviceId: 5, deviceName: 'sw-a', ifName: 'Gi1/0/7', operStatus: 'up', polledAt: new Date(SINCE - 60000).toISOString() };
  const r = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE, port });
  assert.equal(checkOf(r, CHECK.SWITCH_PORT).result, 'unknown');
  assert.match(checkOf(r, CHECK.SWITCH_PORT).detail, /not been polled since the agent went offline/);
});

test('a fresh poll that sees the port up says the access link has carrier', () => {
  const port = { deviceId: 5, ifName: 'Gi1/0/7', operStatus: 'up', polledAt: new Date(NOW - 10000).toISOString() };
  const r = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE, port, probes: probes(true) });
  assert.equal(checkOf(r, CHECK.SWITCH_PORT).result, 'up');
  assert.equal(r.verdict, VERDICT.AGENT_PROCESS_DOWN);
});

test('a license or token rejection outranks everything — the agent is alive and reaching us', () => {
  const port = { deviceId: 5, ifName: 'Gi1/0/7', operStatus: 'down', polledAt: new Date(NOW).toISOString() };
  for (const state of ['license-blocked', 'auth-rejected']) {
    const r = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE, port, site: peers('offline'), connection: { state } });
    assert.equal(r.verdict, VERDICT.REJECTED_BY_SERVER, state);
    assert.equal(checkOf(r, CHECK.CONNECTION).result, 'rejected');
  }
  const plain = assessAgentOffline({ agent, now: NOW, offlineSince: SINCE, connection: { state: 'unreachable' } });
  assert.equal(checkOf(plain, CHECK.CONNECTION).result, 'no_attempts');
});

test('every verdict code has a server-side summary phrase', () => {
  for (const code of VERDICT_CODES) assert.ok(VERDICT_SUMMARY[code], code);
});

// The dashboard builds these keys at runtime from the codes on the finding
// (public/app.js offlineVerdictBlock), so the generic t('literal') sweep in the
// UI gate cannot see them. This sweeps the vocabulary itself.
test('every verdict, check and confidence level has a label in BOTH locales', () => {
  const I18n = require('../public/i18n');
  const keys = [
    ...VERDICT_CODES.map((v) => `ag.offline.verdict.${v}`),
    ...Object.values(CHECK).map((c) => `ag.offline.check.${c}`),
    ...['high', 'medium', 'low'].map((c) => `ag.offline.conf.${c}`),
    'ag.offline.title', 'ag.offline.checks', 'ag.offline.since',
  ];
  const missing = [];
  for (const k of keys) for (const locale of I18n.LOCALES) if (!I18n.has(k, locale)) missing.push(`${k} (${locale})`);
  assert.deepEqual(missing, []);
});
