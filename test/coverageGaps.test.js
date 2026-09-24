'use strict';

// The coverage-gap rules (src/coverage/coverageGaps.js).
//
// The rules that matter most are the ones about what the report must NOT
// claim: a source it could not read is a SKIPPED check, never a clean one, and
// a thing the product does monitor must never be listed as a blind spot.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCoverageReport, CHECKS, KINDS, MULTI_MAC_PORT, STALE_REPORT_MINUTES, prefix24,
} = require('../src/coverage/coverageGaps');

const NOW = new Date('2026-09-23T12:00:00Z');
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
const ok = (value, extra = {}) => ({ status: 'ok', value, ...extra });

const AGENT = (over = {}) => ({
  id: 1, hostname: 'h1', platform: 'linux', status: 'online', location_id: 10, location_name: 'HQ',
  last_seen: minsAgo(1), last_report_at: minsAgo(1), monitor_config: { source: 'sflow' },
  capabilities: { ips: ['10.0.0.5'] }, ...over,
});
const DEVICE = (over = {}) => ({
  id: 5, host: '10.0.0.2', displayName: 'core-sw', enabled: true, agentId: 1, locationId: 10,
  hasCommunity: true, collect: ['if', 'fdb', 'lldp', 'vlan', 'ifcounters'], counterIntervalSec: 300,
  supported: ['if', 'fdb', 'lldp', 'vlan', 'ifcounters'], lastOkAt: minsAgo(2), lastPolledAt: minsAgo(2), lastError: null,
  ...over,
});

// Every source present and clean — the baseline each test perturbs.
function sources(over = {}) {
  return {
    agents: ok([AGENT()]),
    locations: ok([{ id: 10, name: 'HQ' }]),
    snmpDevices: ok([DEVICE()]),
    flows: ok([{ agentId: 1, lastFlowAt: minsAgo(5) }]),
    credentials: ok(new Map()),
    portMacs: ok([]),
    deviceNeighbours: ok([]),
    deviceMacs: ok([{ deviceId: 5, physAddress: '00:11:22:33:44:55' }]),
    agentNeighbours: ok([]),
    agentMacs: ok([]),
    arpSubnets: ok([]),
    discovered: ok({ rows: [], total: 0 }),
    ...over,
  };
}
const build = (over, opts = {}) => buildCoverageReport({ sources: sources(over), now: NOW, ...opts });
const kinds = (r) => r.gaps.map((g) => g.kind);
const check = (r, key) => r.checks.find((c) => c.key === key);

// ============================================================ never invents
test('a clean install with every source read reports no gaps and every check ok', () => {
  const r = build();
  assert.deepEqual(r.gaps, []);
  assert.equal(r.summary.total, 0);
  assert.ok(r.checks.every((c) => c.status === 'ok'), JSON.stringify(r.checks));
  assert.equal(r.checks.length, CHECKS.length);
});

test('a source that could not be read SKIPS its checks — it is never read as "nothing missing"', () => {
  const r = build({ locations: { status: 'failed' }, flows: { status: 'unavailable' } });
  assert.equal(check(r, 'siteAgents').status, 'skipped');
  assert.deepEqual(check(r, 'siteAgents').missing, ['locations']);
  assert.equal(check(r, 'flowCoverage').status, 'skipped');
  // …and the checks that did not need them still ran.
  assert.equal(check(r, 'agentHealth').status, 'ok');
});

test('a read that hit its bound makes the check PARTIAL, and says which source', () => {
  const r = build({ portMacs: ok([], { capped: true }) });
  assert.equal(check(r, 'switchPorts').status, 'partial');
  assert.deepEqual(check(r, 'switchPorts').capped, ['portMacs']);
});

test('the builder survives null, garbage and missing sources', () => {
  for (const input of [null, undefined, 'x', 42, {}, { sources: null }, { sources: { agents: ok(null) } }]) {
    const r = buildCoverageReport(input);
    assert.ok(Array.isArray(r.gaps));
    assert.ok(Array.isArray(r.checks));
  }
});

// ============================================================ sites
test('a site with no agent is a warning, with its switch count as evidence', () => {
  const r = build({ locations: ok([{ id: 10, name: 'HQ' }, { id: 11, name: 'Branch' }]) });
  const g = r.gaps.find((x) => x.kind === 'siteNoAgent');
  assert.equal(g.severity, 'warn');
  assert.equal(g.scope, 'site');
  assert.deepEqual(g.subject, { id: 11, label: 'Branch' });
  assert.equal(g.evidence.snmpDevices, 0);
  assert.equal(g.suggestion, 'enrollAgent');
});

test('a site whose agents are all proc and has no switch sees only the agents', () => {
  const r = build({
    agents: ok([AGENT({ monitor_config: { source: 'proc' } })]),
    snmpDevices: ok([DEVICE({ locationId: 99 })]),
  });
  const g = r.gaps.find((x) => x.kind === 'siteNoFlowOrSnmp');
  assert.ok(g);
  assert.equal(g.evidence.agents, 1);
  assert.equal(g.evidence.sources, 'proc');
  // The site-level "no flows" says the same thing less usefully — not doubled.
  assert.ok(!kinds(r).includes('siteNoFlows'));
  // A switch at the site is a source.
  const withSwitch = build({ agents: ok([AGENT({ monitor_config: { source: 'proc' } })]) });
  assert.ok(!kinds(withSwitch).includes('siteNoFlowOrSnmp'));
});

// ============================================================ agents
test('offline and stale agents are warnings; promoted SNMP pseudo-agents are ignored', () => {
  const r = build({
    agents: ok([
      AGENT({ id: 1 }),
      AGENT({ id: 2, hostname: 'down', status: 'offline' }),
      AGENT({ id: 3, hostname: 'quiet', last_report_at: minsAgo(STALE_REPORT_MINUTES + 5) }),
      AGENT({ id: 4, hostname: 'never', last_report_at: null }),
      AGENT({ id: 9, hostname: 'printer', platform: 'snmp', status: 'offline' }),
    ]),
  });
  assert.deepEqual(r.gaps.filter((g) => g.kind === 'agentOffline').map((g) => g.subject.id), [2]);
  assert.deepEqual(r.gaps.filter((g) => g.kind === 'agentStale').map((g) => g.subject.id).sort(), [3, 4]);
  assert.ok(!r.gaps.some((g) => g.subject.id === 9 && g.scope === 'agent'));
});

test('a proc agent sees only itself (info)', () => {
  const r = build({ agents: ok([AGENT({ monitor_config: null })]) });
  const g = r.gaps.find((x) => x.kind === 'agentProcOnly');
  assert.equal(g.severity, 'info');
  assert.equal(g.suggestion, 'setFlowSource');
});

test('a flow-source agent with no flow record in 24 h is a warning; a recent one is not', () => {
  const r = build({
    agents: ok([AGENT({ id: 1 }), AGENT({ id: 2, hostname: 'silent', monitor_config: { source: 'netflow' } })]),
    flows: ok([{ agentId: 1, lastFlowAt: minsAgo(10) }, { agentId: 2, lastFlowAt: minsAgo(25 * 60) }]),
  });
  const silent = r.gaps.filter((g) => g.kind === 'agentNoFlows');
  assert.deepEqual(silent.map((g) => g.subject.id), [2]);
  assert.equal(silent[0].evidence.windowHours, 24);
  assert.ok(silent[0].evidence.lastFlowAt);
  // The site still has one agent with flows.
  assert.ok(!kinds(r).includes('siteNoFlows'));
});

test('a site where no agent produced a flow in 24 h is reported once', () => {
  const r = build({ flows: ok([]) });
  assert.equal(r.gaps.filter((g) => g.kind === 'siteNoFlows').length, 1);
  assert.equal(r.gaps.filter((g) => g.kind === 'agentNoFlows').length, 1);
});

// ============================================================ SNMP devices
test('switch polling state: disabled / no poller / never answered / failing', () => {
  const r = build({
    snmpDevices: ok([
      DEVICE({ id: 5 }),
      DEVICE({ id: 6, displayName: 'off', enabled: false }),
      DEVICE({ id: 7, displayName: 'orphan', agentId: null }),
      DEVICE({ id: 8, displayName: 'new', lastOkAt: null, lastError: 'timeout' }),
      DEVICE({ id: 9, displayName: 'flaky', lastError: 'timeout' }),
    ]),
  });
  const of = (k) => r.gaps.filter((g) => g.kind === k).map((g) => g.subject.id);
  assert.deepEqual(of('deviceDisabled'), [6]);
  assert.deepEqual(of('deviceNoPoller'), [7]);
  assert.deepEqual(of('deviceNeverPolled'), [8]);
  assert.deepEqual(of('deviceError'), [9]);
  assert.equal(r.gaps.find((g) => g.kind === 'deviceNeverPolled').evidence.lastError, 'timeout');
});

test('no credential: named when a community exists but is not granted', () => {
  const creds = new Map([[5, { resolved: false, blocked: 3 }], [6, { resolved: false, blocked: null }], [7, { resolved: true, blocked: null }]]);
  const r = build({
    snmpDevices: ok([DEVICE({ id: 5 }), DEVICE({ id: 6 }), DEVICE({ id: 7 })]),
    credentials: ok(creds),
  });
  const g = r.gaps.filter((x) => x.kind === 'deviceNoCredential');
  assert.deepEqual(g.map((x) => [x.subject.id, x.suggestion]), [[5, 'grantCredential'], [6, 'assignCredential']].sort((a, b) => a[0] - b[0]));
});

test('what a polled switch does not collect: counters, LLDP, FDB — and "cannot" vs "not asked"', () => {
  const r = build({
    snmpDevices: ok([
      DEVICE({ id: 5, collect: ['if', 'fdb', 'lldp'], counterIntervalSec: null }),
      DEVICE({ id: 6, displayName: 'dumb', supported: ['if', 'ifcounters'] }),
      // Never answered: what it collects is not the gap yet.
      DEVICE({ id: 7, displayName: 'new', lastOkAt: null, collect: ['if'] }),
    ]),
  });
  const counters = r.gaps.find((g) => g.kind === 'deviceNoCounters');
  assert.equal(counters.subject.id, 5);
  assert.equal(counters.suggestion, 'enableCounters');
  const lldp = r.gaps.filter((g) => g.kind === 'deviceNoLldp');
  assert.deepEqual(lldp.map((g) => [g.subject.id, g.suggestion]), [[6, 'deviceLacks']]);
  assert.equal(r.gaps.find((g) => g.kind === 'deviceNoFdb').evidence.unsupported, true);
  assert.ok(!r.gaps.some((g) => g.subject.id === 7 && /deviceNo(Counters|Lldp|Fdb)/.test(g.kind)));
});

// ============================================================ switch ports
test('unknown MACs on up ports are counted per switch; known, LLDP-facing and uplink sightings are not', () => {
  const r = build({
    snmpDevices: ok([DEVICE({ id: 5 }), DEVICE({ id: 6, displayName: 'edge' })]),
    deviceMacs: ok([{ deviceId: 5, physAddress: '00:11:22:33:44:55' }, { deviceId: 6, physAddress: '00:11:22:33:44:66' }]),
    agentMacs: ok([{ ip: '10.0.0.5', mac: 'aa:aa:aa:aa:aa:01' }]),
    deviceNeighbours: ok([{ deviceId: 5, localIfName: 'Gi0/48', remoteChassisId: '00:11:22:33:44:66', remoteSysName: 'edge' }]),
    portMacs: ok([
      // A PC on the edge switch, also learned on the core's uplink toward it.
      { deviceId: 6, ifName: 'Gi0/3', mac: 'bb:bb:bb:bb:bb:01', portMacCount: 1 },
      { deviceId: 5, ifName: 'Gi0/48', mac: 'bb:bb:bb:bb:bb:01', portMacCount: 30 },
      // The agent's own NIC: known.
      { deviceId: 6, ifName: 'Gi0/4', mac: 'aa:aa:aa:aa:aa:01', portMacCount: 1 },
      // The other switch's own port MAC: known.
      { deviceId: 5, ifName: 'Gi0/7', mac: '00:11:22:33:44:66', portMacCount: 1 },
      // Something with its own ports behind it on the core.
      ...[1, 2, 3, 4].map((i) => ({ deviceId: 5, ifName: 'Gi0/9', mac: `cc:cc:cc:cc:cc:0${i}`, portMacCount: 4 })),
    ]),
  });
  const hosts = r.gaps.filter((g) => g.kind === 'unmonitoredHosts');
  const byId = Object.fromEntries(hosts.map((g) => [g.subject.id, g]));
  assert.equal(byId[6].evidence.macs, 1, 'the PC counts once, on its access port');
  assert.deepEqual(byId[6].evidence.topPorts, [{ ifName: 'Gi0/3', macs: 1 }]);
  assert.equal(byId[6].severity, 'info');
  assert.equal(byId[5].evidence.macs, MULTI_MAC_PORT);
  assert.equal(byId[5].evidence.multiMacPorts, 1);
  assert.equal(byId[5].severity, 'warn', 'several unknown MACs on one port reads as an unmanaged switch');
});

// ============================================================ neighbours
test('LLDP neighbours nothing monitors are listed once per chassis, with who saw them', () => {
  const r = build({
    snmpDevices: ok([DEVICE({ id: 5 }), DEVICE({ id: 6, displayName: 'edge' })]),
    deviceMacs: ok([{ deviceId: 5, physAddress: '00:11:22:33:44:55' }, { deviceId: 6, physAddress: '00:11:22:33:44:66' }]),
    deviceNeighbours: ok([
      { deviceId: 5, localIfName: 'Gi0/48', remoteChassisId: '00:11:22:33:44:66', remoteSysName: 'x' }, // known by MAC
      { deviceId: 5, localIfName: 'Gi0/1', remoteChassisId: 'h1', remoteSysName: null }, // an agent, by name
      { deviceId: 5, localIfName: 'Gi0/2', remoteChassisId: 'de:ad:be:ef:00:01', remoteSysName: 'closet-sw' },
      { deviceId: 6, localIfName: 'Gi0/1', remoteChassisId: 'DEAD.BEEF.0001', remoteSysName: 'closet-sw' },
    ]),
    agentNeighbours: ok([
      { localAgentId: 1, localChassisId: 'aa:aa:aa:aa:aa:01', localPort: 'eth0', remoteChassisId: '00:11:22:33:44:55' }, // the core, known
      { localAgentId: 1, localChassisId: 'aa:aa:aa:aa:aa:01', localPort: 'eth1', remoteChassisId: 'ee:ee:ee:ee:ee:01' },
    ]),
  });
  const n = r.gaps.filter((g) => g.kind === 'unmanagedNeighbour');
  assert.equal(n.length, 2, JSON.stringify(n));
  const closet = n.find((g) => g.subject.label === 'closet-sw');
  assert.equal(closet.evidence.seenByCount, 2, 'two spellings of one MAC are one neighbour');
  assert.equal(closet.severity, 'warn', 'seen from two monitored things: it is in the path');
  const behindAgent = n.find((g) => g.evidence.chassisId === 'ee:ee:ee:ee:ee:01');
  assert.equal(behindAgent.severity, 'info');
  assert.deepEqual(behindAgent.evidence.seenBy[0], { type: 'agent', id: 1, label: 'h1', port: 'eth1' });
});

// ============================================================ subnets
test('a /24 the ARP tables mention with no agent in it is uncovered; reserved space never is', () => {
  const r = build({
    arpSubnets: ok([
      { prefix: '10.0.0', ips: 40, agents: 1, lastSeen: minsAgo(3) }, // the agent's own
      { prefix: '10.0.1', ips: 12, agents: 1, lastSeen: minsAgo(3) },
      { prefix: '169.254.1', ips: 2, agents: 1, lastSeen: minsAgo(3) },
      { prefix: '127.0.0', ips: 1, agents: 1, lastSeen: minsAgo(3) },
    ]),
  });
  const s = r.gaps.filter((g) => g.kind === 'subnetUncovered');
  assert.deepEqual(s.map((g) => g.subject.id), ['10.0.1.0/24']);
  assert.equal(s[0].evidence.ips, 12);
  assert.equal(s[0].scope, 'subnet');
});

test('an agent that reports no IPs makes the subnet check partial, and says how many', () => {
  const r = build({ agents: ok([AGENT(), AGENT({ id: 2, capabilities: {} })]) });
  assert.equal(check(r, 'subnets').status, 'partial');
  assert.equal(check(r, 'subnets').agentsWithoutIps, 1);
});

test('prefix24 accepts dotted quads only', () => {
  assert.equal(prefix24('10.1.2.3'), '10.1.2');
  assert.equal(prefix24('10.1.2'), null);
  assert.equal(prefix24('fe80::1'), null);
  assert.equal(prefix24('300.1.2.3'), null);
});

// ============================================================ discovery
test('discovery candidates nobody reviewed are listed; the total counts beyond the list', () => {
  const r = build({
    discovered: ok({ rows: [{ id: 3, ip: '10.0.1.9', hostname: null, openPorts: [22, 443], lastSeen: minsAgo(60) }], total: 7 }),
  });
  const g = r.gaps.find((x) => x.kind === 'discoveredPending');
  assert.equal(g.subject.label, '10.0.1.9');
  assert.equal(g.evidence.openPorts, '22, 443');
  assert.equal(r.summary.byKind.discoveredPending, 7);
  assert.equal(r.truncated.discoveredPending, 6);
});

// ============================================================ bounds + shape
test('every list is capped per kind; the summary still counts everything', () => {
  const locs = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, name: `S${String(i).padStart(2, '0')}` }));
  const r = build({ locations: ok([{ id: 10, name: 'HQ' }, ...locs]) }, { limit: 5 });
  assert.equal(r.gaps.filter((g) => g.kind === 'siteNoAgent').length, 5);
  assert.equal(r.summary.byKind.siteNoAgent, 30);
  assert.equal(r.truncated.siteNoAgent, 25);
  assert.equal(r.limit, 5);
});

test('every gap has the documented shape, and every kind has a known scope', () => {
  const r = build({
    locations: ok([{ id: 10, name: 'HQ' }, { id: 11, name: 'B' }]),
    agents: ok([AGENT({ status: 'offline' }), AGENT({ id: 2, monitor_config: null })]),
    snmpDevices: ok([DEVICE({ agentId: null })]),
  });
  assert.ok(r.gaps.length > 0);
  for (const g of r.gaps) {
    assert.ok(KINDS[g.kind], g.kind);
    assert.ok(['warn', 'info'].includes(g.severity));
    assert.ok(['site', 'agent', 'device', 'subnet'].includes(g.scope));
    assert.ok(g.subject && g.subject.id != null && g.subject.label);
    assert.equal(typeof g.evidence, 'object');
    assert.equal(typeof g.suggestion, 'string');
  }
  assert.equal(r.summary.total, r.summary.warn + r.summary.info);
});
