'use strict';

// Two coverage gaps that were wrong in a real end-to-end run (real agent, real
// server, snmpsim switches, hsflowd):
//
//   * EVERY switch was listed as "cannot provide counters", including ones
//     sending counter samples every minute. The check read `supported`, which
//     is the TOPOLOGY cycle's findings — the agent never lists 'ifcounters'
//     there, because counters are a separate cycle. It is judged now on what
//     is true: collect + an interval + a recent counter poll.
//   * The agent host's OWN hsflowd was listed as an "sFlow exporter not
//     registered", asking the operator to add the agent's own address as an
//     SNMP device. An agent's own addresses (capabilities.ips) are excluded.
//
// And one that follows from sysName (migration 133): a managed switch that its
// neighbour's LLDP names by sysName is not an "unmanaged neighbour".

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildCoverageReport } = require('../src/coverage/coverageGaps');

const NOW = new Date('2026-09-24T08:30:00Z');
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
const ok = (value) => ({ status: 'ok', value });

const AGENT = (over = {}) => ({
  id: 1, hostname: 'be-collector', platform: 'linux', status: 'online', location_id: 10, location_name: 'HQ',
  last_seen: minsAgo(1), last_report_at: minsAgo(1), monitor_config: { source: 'sflow' },
  capabilities: { ips: ['192.0.2.2'] }, ...over,
});
// Exactly what the agent reports: `supported` from the topology cycle, no
// 'ifcounters' in it.
const SWITCH = (over = {}) => ({
  id: 1, host: '198.51.100.2', displayName: 'Core', sysName: 'sw-core', enabled: true, agentId: 1, locationId: 10,
  hasCommunity: true, collect: ['if', 'fdb', 'lldp', 'vlan', 'ifcounters'], counterIntervalSec: 60,
  supported: ['if', 'fdb', 'lldp', 'vlan'], lastOkAt: minsAgo(2), lastPolledAt: minsAgo(2), lastError: null,
  lastUptimeAt: minsAgo(1), ...over,
});
const build = (over = {}) => buildCoverageReport({
  now: NOW,
  sources: {
    agents: ok([AGENT()]),
    locations: ok([{ id: 10, name: 'HQ' }]),
    snmpDevices: ok([SWITCH()]),
    flows: ok([{ agentId: 1, lastFlowAt: minsAgo(5) }]),
    credentials: ok(new Map()),
    portMacs: ok([]),
    deviceNeighbours: ok([]),
    deviceMacs: ok([]),
    agentNeighbours: ok([]),
    agentMacs: ok([]),
    arpSubnets: ok([]),
    discovered: ok({ rows: [], total: 0 }),
    sflowExporters: ok([]),
    ...over,
  },
});
const counterGaps = (r) => r.gaps.filter((g) => g.kind === 'deviceNoCounters');

test('a switch delivering counters is not a counter gap, though `supported` never names ifcounters', () => {
  assert.deepEqual(counterGaps(build()), []);
});

test('counters not asked for, or asked for with no interval, is "enable counters"', () => {
  const r = build({
    snmpDevices: ok([
      SWITCH({ id: 1, collect: ['if', 'fdb'], lastUptimeAt: null }),
      SWITCH({ id: 2, host: '198.51.100.3', counterIntervalSec: null, lastUptimeAt: null }),
    ]),
  });
  const g = counterGaps(r);
  assert.deepEqual(g.map((x) => [x.subject.id, x.suggestion, x.evidence.inCollect, x.evidence.noInterval]),
    [[1, 'enableCounters', false, false], [2, 'enableCounters', true, true]]);
  assert.ok(g.every((x) => x.evidence.unsupported === false), 'nothing claims the device cannot count');
});

test('counters configured but never, or no longer, arriving is "check counter polling", with the last poll named', () => {
  const r = build({
    snmpDevices: ok([
      SWITCH({ id: 1, lastUptimeAt: null }),
      // 60 s interval: stale after max(3 × 60 s, 30 min) = 30 min.
      SWITCH({ id: 2, host: '198.51.100.3', lastUptimeAt: minsAgo(45) }),
      SWITCH({ id: 3, host: '198.51.100.4', lastUptimeAt: minsAgo(20) }),
      // 1 h interval: three cycles is the bound.
      SWITCH({ id: 4, host: '198.51.100.5', counterIntervalSec: 3600, lastUptimeAt: minsAgo(150) }),
    ]),
  });
  const g = counterGaps(r);
  assert.deepEqual(g.map((x) => [x.subject.id, x.suggestion]), [[1, 'checkCounterPolling'], [2, 'checkCounterPolling']]);
  assert.equal(g[0].evidence.lastCounterPollAt, null);
  assert.equal(g[1].evidence.lastCounterPollAt, minsAgo(45));
  assert.equal(g[1].evidence.noCounterPoll, true);
});

test('an sFlow exporter at an agent\'s OWN address is not a switch to register', () => {
  const EXPORTER = (over = {}) => ({ id: 1, agentId: 1, address: '192.0.2.2', deviceId: null, interfaces: 1, lastSeen: minsAgo(1), ...over });
  const r = build({
    agents: ok([AGENT(), AGENT({ id: 2, hostname: 'be-other', capabilities: { ips: ['2001:db8::20'] } })]),
    sflowExporters: ok([
      EXPORTER(),
      // Another agent's own address, heard by this one — still that host's own.
      EXPORTER({ id: 2, address: '2001:DB8:0:0::20' }),
      // A real unregistered switch.
      EXPORTER({ id: 3, address: '198.51.100.40', interfaces: 24 }),
    ]),
  });
  const g = r.gaps.filter((x) => x.kind === 'sflowExporterUnregistered');
  assert.deepEqual(g.map((x) => x.subject.label), ['198.51.100.40']);
});

test('a neighbour named by a polled switch\'s sysName is that switch, not an unmanaged neighbour', () => {
  const r = build({
    snmpDevices: ok([SWITCH(), SWITCH({ id: 2, host: '198.51.100.3', displayName: 'Access', sysName: 'sw-access-7' })]),
    deviceNeighbours: ok([{ deviceId: 1, localIfName: 'Gi0/48', remoteChassisId: 'sw-access-7', remoteSysName: 'sw-access-7' }]),
  });
  assert.deepEqual(r.gaps.filter((x) => x.kind === 'unmanagedNeighbour'), []);
});
