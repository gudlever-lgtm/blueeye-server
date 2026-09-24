'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// New-device detection (src/discovery/newDeviceDetector.js): a MAC no agent at
// the site has seen before — or an address discovery never found — becomes a
// `device.new` finding. The property that matters most is the one that is
// easiest to get wrong: an agent's FIRST neighbour table is all "new", and it
// must not become a page per neighbour.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  createNewDeviceDetector, withArpDetection, withDiscoveryDetection, loadNewDeviceConfig, METRIC,
} = require('../src/discovery/newDeviceDetector');
const { fromFindings, buildChangeFeed } = require('../src/changes/changeFeed');
const { vendorForMac, isLocallyAdministered } = require('../src/identity/oui');
const {
  makeApp, makeAgentTokensRepo, makeArpEntriesRepo, makeDiscoveredDevicesRepo,
} = require('../test-support/fakes');

const NOW = new Date('2026-09-23T12:00:00Z');
const HOUR = 3600 * 1000;
const hoursAgo = (h) => new Date(NOW.getTime() - h * HOUR);

function makeStore() {
  const saved = [];
  return { saved, async save(f) { saved.push(f); return { ...f }; } };
}

const agentsRepo = {
  async findById(id) {
    const rows = {
      9: { id: 9, hostname: 'plc-gw', display_name: 'PLC gateway', location_id: 3 },
      10: { id: 10, hostname: 'scada-01', display_name: null, location_id: 3 },
      11: { id: 11, hostname: 'lonely', display_name: null, location_id: null },
    };
    return rows[Number(id)] || null;
  },
};
const locationsRepo = { async findById(id) { return Number(id) === 3 ? { id: 3, name: 'Plant A' } : null; } };

const config = (over = {}) => ({ enabled: true, baselineHours: 24, maxPerHour: 20, severity: 'WARN', ...over });

// An arp_entries fake where agent 9 has held a baseline for two days.
async function seededArp({ baselineHours = 48, agentSite = { 9: 3, 10: 3, 11: null } } = {}) {
  const arp = makeArpEntriesRepo({ agentSite });
  await arp.upsertMany(9, [
    { ip: '10.20.0.1', mac: '00:00:0c:aa:bb:01', interface: 'eth0' },
    { ip: '10.20.0.2', mac: '00:00:0c:aa:bb:02', interface: 'eth0' },
  ], { at: hoursAgo(baselineHours) });
  return arp;
}

function detector(over = {}) {
  const findingStore = over.findingStore || makeStore();
  const d = createNewDeviceDetector({
    agentsRepo, locationsRepo, findingStore, config: config(over.config), now: () => NOW, ...over.deps,
  });
  return { d, findingStore };
}

async function observe(d, arp, agentId, entries) {
  const pending = await d.checkArp(agentId, entries);
  await arp.upsertMany(agentId, entries, { at: NOW });
  return d.raiseArp(pending);
}

// ---- the flood guard ----------------------------------------------------------

test('NO FLOOD: an agent\'s first neighbour table raises nothing, however many neighbours it has', async () => {
  const arp = makeArpEntriesRepo({ agentSite: { 9: 3 } });
  const { d, findingStore } = detector({ deps: { arpEntriesRepo: arp } });
  const first = Array.from({ length: 40 }, (_, i) => ({ ip: `10.20.1.${i + 1}`, mac: `00:1b:1b:00:00:${String(i).padStart(2, '0')}` }));
  const out = await observe(d, arp, 9, first);
  assert.deepEqual(out, []);
  assert.equal(findingStore.saved.length, 0);
  assert.equal(arp.rows.length, 40, 'the table is still stored — it becomes the baseline');
});

test('NO FLOOD: a baseline younger than baselineHours is still a warm-up, not a verdict', async () => {
  const arp = await seededArp({ baselineHours: 3 });
  const { d, findingStore } = detector({ deps: { arpEntriesRepo: arp } });
  await observe(d, arp, 9, [{ ip: '10.20.0.77', mac: '00:1b:1b:12:34:56' }]);
  assert.equal(findingStore.saved.length, 0);
});

// ---- the verdict --------------------------------------------------------------

test('a MAC never seen at the site becomes a device.new finding naming IP, MAC, vendor, agent and site', async () => {
  const arp = await seededArp();
  const published = [];
  const dispatched = [];
  const assigned = [];
  const { d, findingStore } = detector({
    deps: {
      arpEntriesRepo: arp,
      publishFinding: (hostId, msg) => published.push(msg),
      getDispatcher: () => ({ dispatch: async (f) => { dispatched.push(f); } }),
      alertingEnabled: () => true,
      eventCaseService: { assignFinding: async (f) => { assigned.push(f.id); } },
    },
  });
  const out = await observe(d, arp, 9, [
    { ip: '10.20.0.1', mac: '00:00:0c:aa:bb:01', interface: 'eth0' }, // known
    { ip: '10.20.0.57', mac: '00:1b:1b:12:34:56', interface: 'eth1' }, // new
  ]);
  assert.equal(out.length, 1);
  const f = findingStore.saved[0];
  assert.equal(f.metric, METRIC);
  assert.equal(f.metric, 'device.new');
  assert.equal(f.hostId, '9');
  assert.equal(f.severity, 'WARN');
  assert.equal(f.kind, 'THRESHOLD');
  for (const needle of ['10.20.0.57', '00:1b:1b:12:34:56', 'Siemens', 'PLC gateway', 'Plant A', 'eth1', 'not a first snapshot']) {
    assert.ok(f.explanation.includes(needle), `explanation lacks "${needle}": ${f.explanation}`);
  }
  assert.deepEqual(
    { ip: f.evidence[0].labels.ip, mac: f.evidence[0].labels.mac, vendor: f.evidence[0].labels.vendor, site: f.evidence[0].labels.siteName, source: f.evidence[0].labels.source },
    { ip: '10.20.0.57', mac: '00:1b:1b:12:34:56', vendor: 'Siemens', site: 'Plant A', source: 'arp' },
  );
  assert.equal(f.evidence[0].target, '10.20.0.57');
  assert.equal(published.length, 1);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(assigned, [f.id]);
});

test('alerting off: the finding is stored and published, but not dispatched', async () => {
  const arp = await seededArp();
  const dispatched = [];
  const { d, findingStore } = detector({
    deps: { arpEntriesRepo: arp, getDispatcher: () => ({ dispatch: async (f) => dispatched.push(f) }), alertingEnabled: () => false },
  });
  await observe(d, arp, 9, [{ ip: '10.20.0.57', mac: '00:1b:1b:12:34:56' }]);
  assert.equal(findingStore.saved.length, 1);
  assert.equal(dispatched.length, 0);
});

test('a MAC another agent at the SAME site already knows is not new', async () => {
  const arp = await seededArp();
  await arp.upsertMany(10, [{ ip: '10.20.0.99', mac: '00:90:e8:00:00:01' }], { at: hoursAgo(30) });
  const { d, findingStore } = detector({ deps: { arpEntriesRepo: arp } });
  await observe(d, arp, 9, [{ ip: '10.20.0.99', mac: '00:90:e8:00:00:01' }]);
  assert.equal(findingStore.saved.length, 0);
});

test('a known MAC on a new IP (a DHCP renewal) is not a new device', async () => {
  const arp = await seededArp();
  const { d, findingStore } = detector({ deps: { arpEntriesRepo: arp } });
  await observe(d, arp, 9, [{ ip: '10.20.0.200', mac: '00:00:0c:aa:bb:02' }]);
  assert.equal(findingStore.saved.length, 0);
});

test('one new MAC seen twice in the same report is one finding; a second report does not re-raise it', async () => {
  const arp = await seededArp();
  const { d, findingStore } = detector({ deps: { arpEntriesRepo: arp } });
  await observe(d, arp, 9, [
    { ip: '10.20.0.57', mac: '00:1b:1b:12:34:56', interface: 'eth1' },
    { ip: '10.20.0.58', mac: '00:1b:1b:12:34:56', interface: 'eth1' },
  ]);
  await observe(d, arp, 9, [{ ip: '10.20.0.57', mac: '00:1b:1b:12:34:56' }]);
  assert.equal(findingStore.saved.length, 1);
});

test('an agent without a site is scoped to its own table, and a randomised MAC says why it has no vendor', async () => {
  const arp = makeArpEntriesRepo({ agentSite: { 11: null } });
  await arp.upsertMany(11, [{ ip: '192.168.5.1', mac: '00:00:0c:00:00:01' }], { at: hoursAgo(100) });
  const { d, findingStore } = detector({ deps: { arpEntriesRepo: arp } });
  await observe(d, arp, 11, [{ ip: '192.168.5.40', mac: 'da:a1:19:00:00:01' }]);
  assert.equal(findingStore.saved.length, 1);
  assert.match(findingStore.saved[0].explanation, /locally administered/);
  assert.doesNotMatch(findingStore.saved[0].explanation, /at site/);
});

test('the hourly cap: N findings, then ONE summary for the rest — never silence, never a flood', async () => {
  const arp = await seededArp();
  const { d, findingStore } = detector({ deps: { arpEntriesRepo: arp }, config: { maxPerHour: 2 } });
  const burst = Array.from({ length: 5 }, (_, i) => ({ ip: `10.20.2.${i + 1}`, mac: `00:30:de:00:00:0${i}` }));
  await observe(d, arp, 9, burst);
  assert.equal(findingStore.saved.length, 3);
  const summary = findingStore.saved[2];
  assert.equal(summary.evidence[0].labels.summary, true);
  assert.equal(summary.evidence[0].labels.count, 3);
  assert.match(summary.explanation, /3 more new device\(s\)/);
  assert.match(summary.explanation, /NEW_DEVICE_MAX_PER_HOUR/);
  // More within the same hour: budget spent, summary already raised.
  await observe(d, arp, 9, [{ ip: '10.20.3.1', mac: '00:30:de:00:01:00' }]);
  assert.equal(findingStore.saved.length, 3);
});

test('switched off (NEW_DEVICE_ALERTS_ENABLED=false) or unlicensed: nothing is raised', async () => {
  for (const variant of [{ config: { enabled: false } }, { deps: { licensed: () => false } }]) {
    // eslint-disable-next-line no-await-in-loop
    const arp = await seededArp();
    const { d, findingStore } = detector({ ...variant, deps: { arpEntriesRepo: arp, ...(variant.deps || {}) } });
    // eslint-disable-next-line no-await-in-loop
    await observe(d, arp, 9, [{ ip: '10.20.0.57', mac: '00:1b:1b:12:34:56' }]);
    assert.equal(findingStore.saved.length, 0);
  }
});

test('a failing finding store is logged and swallowed', async () => {
  const arp = await seededArp();
  const warnings = [];
  const { d } = detector({
    findingStore: { async save() { throw new Error('db down'); } },
    deps: { arpEntriesRepo: arp, logger: { warn: (m) => warnings.push(m) } },
  });
  const out = await observe(d, arp, 9, [{ ip: '10.20.0.57', mac: '00:1b:1b:12:34:56' }]);
  assert.deepEqual(out, []);
  assert.match(warnings.join('\n'), /db down/);
});

// ---- the repository wrapper ---------------------------------------------------

async function eventually(fn, ms = 500) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5));
  }
  return fn();
}

test('withArpDetection: the capabilities report raises the finding through the real route', async () => {
  const arp = await seededArp();
  const { d, findingStore } = detector({ deps: { arpEntriesRepo: arp } });
  const app = makeApp({
    arpEntriesRepo: withArpDetection(arp, d),
    agentTokensRepo: makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) }),
  });
  const res = await request(app).post('/agents/me/capabilities').set('Authorization', 'Bearer agent-tok')
    .send({ capabilities: { sources: ['proc'], arp: [{ ip: '10.20.0.57', mac: '00-1B-1B-12-34-56', interface: 'eth1' }] } });
  assert.equal(res.status, 200);
  assert.ok(await eventually(() => findingStore.saved.length === 1), 'no finding raised');
  assert.equal(findingStore.saved[0].evidence[0].labels.mac, '00:1b:1b:12:34:56');
  assert.ok(arp.rows.some((r) => r.ip === '10.20.0.57'), 'the entry is stored as before');
});

test('withArpDetection: a detector that throws never blocks the write it watches', async () => {
  const arp = makeArpEntriesRepo();
  const broken = { checkArp: async () => { throw new Error('boom'); }, raiseArp: async () => [] };
  const warnings = [];
  const wrapped = withArpDetection(arp, broken, { logger: { warn: (m) => warnings.push(m) } });
  assert.equal(await wrapped.upsertMany(9, [{ ip: '10.0.0.1', mac: '00:00:0c:00:00:01' }]), 1);
  assert.equal(arp.rows.length, 1);
  assert.match(warnings[0], /boom/);
  assert.equal(typeof wrapped.findByMac, 'function', 'the rest of the repository passes through');
});

// ---- discovery ----------------------------------------------------------------

async function seededDiscovery() {
  const repo = makeDiscoveredDevicesRepo();
  await repo.upsertCandidate({ ip: '10.20.0.1', seenAt: hoursAgo(72) });
  return repo;
}

test('discovery: an address no sweep and no ARP table has seen is new (IP only — a sweep sees no MAC)', async () => {
  const discovered = await seededDiscovery();
  const arp = await seededArp();
  const { d, findingStore } = detector({ deps: { discoveredDevicesRepo: discovered, arpEntriesRepo: arp } });
  const wrapped = withDiscoveryDetection(discovered, d);
  await wrapped.upsertCandidate({ ip: '10.20.0.150', hostname: 'rtu-7', openPorts: [502, 20000], foundByAgentId: 9 });
  assert.ok(await eventually(() => findingStore.saved.length === 1));
  const f = findingStore.saved[0];
  assert.equal(f.metric, 'device.new');
  assert.equal(f.hostId, '9');
  for (const needle of ['10.20.0.150', 'rtu-7', '502, 20000', 'PLC gateway', 'Plant A', 'not a first sweep']) {
    assert.ok(f.explanation.includes(needle), `explanation lacks "${needle}"`);
  }
  assert.equal(f.evidence[0].labels.source, 'discovery');
  assert.equal(f.evidence[0].labels.mac, null);
});

test('discovery: a refresh, an ARP-known address and a first sweep are not new', async () => {
  const arp = await seededArp();
  // First sweep ever: everything is new, nothing is flagged.
  const empty = makeDiscoveredDevicesRepo();
  const a = detector({ deps: { discoveredDevicesRepo: empty, arpEntriesRepo: arp } });
  await withDiscoveryDetection(empty, a.d).upsertCandidate({ ip: '10.20.9.9' });

  const discovered = await seededDiscovery();
  const b = detector({ deps: { discoveredDevicesRepo: discovered, arpEntriesRepo: arp } });
  const wrapped = withDiscoveryDetection(discovered, b.d);
  await wrapped.upsertCandidate({ ip: '10.20.0.1' }); // refresh of a known candidate
  await wrapped.upsertCandidate({ ip: '10.20.0.2' }); // in agent 9's ARP table already
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(a.findingStore.saved.length, 0);
  assert.equal(b.findingStore.saved.length, 0);
  assert.equal(discovered.rows.length, 2, 'writes still happen');
});

test('discovery by the server\'s own sweep (no agent) is attributed to "discovery"', async () => {
  const discovered = await seededDiscovery();
  const { d, findingStore } = detector({ deps: { discoveredDevicesRepo: discovered } });
  const pending = await d.checkDiscovery({ ip: '10.20.0.151' });
  await discovered.upsertCandidate({ ip: '10.20.0.151' });
  await d.raiseDiscovery(pending);
  assert.equal(findingStore.saved[0].hostId, 'discovery');
  assert.match(findingStore.saved[0].explanation, /server's discovery sweep/);
});

// ---- config, vendor hint, changes feed -----------------------------------------

test('loadNewDeviceConfig: on by default, 24 h baseline, env-switchable', () => {
  assert.deepEqual(loadNewDeviceConfig({}), { enabled: true, baselineHours: 24, maxPerHour: 20, severity: 'WARN' });
  const c = loadNewDeviceConfig({
    NEW_DEVICE_ALERTS_ENABLED: 'false', NEW_DEVICE_BASELINE_HOURS: '72', NEW_DEVICE_MAX_PER_HOUR: '5', NEW_DEVICE_SEVERITY: 'crit',
  });
  assert.deepEqual(c, { enabled: false, baselineHours: 72, maxPerHour: 5, severity: 'CRIT' });
  assert.equal(loadNewDeviceConfig({ NEW_DEVICE_SEVERITY: 'LOUD' }).severity, 'WARN');
});

test('vendor hint: a curated OUI subset, unknown stays unknown', () => {
  assert.equal(vendorForMac('00:1b:1b:12:34:56'), 'Siemens');
  assert.equal(vendorForMac('00:0C:29:00:00:01'), 'VMware');
  assert.equal(vendorForMac('12:34:56:78:9a:bc'), null);
  assert.equal(vendorForMac('not-a-mac'), null);
  assert.equal(isLocallyAdministered('da:a1:19:00:00:01'), true);
  assert.equal(isLocallyAdministered('00:1b:1b:12:34:56'), false);
  assert.equal(vendorForMac('aa:bb:cc:00:00:01', { 'aa:bb:cc': 'Custom' }), 'Custom');
});

test('changes feed: a device.new finding is a "new_device" row that says what appeared', () => {
  const at = new Date('2026-09-23T10:00:00Z');
  const finding = {
    id: 'f1', hostId: '9', metric: 'device.new', severity: 'WARN', createdAt: at, eventCaseId: 77,
    evidence: [{ target: '10.20.0.57', labels: { ip: '10.20.0.57', mac: '00:1b:1b:12:34:56', vendor: 'Siemens', siteName: 'Plant A' } }],
  };
  const [row] = fromFindings([finding], { nameFor: () => 'PLC gateway' });
  assert.equal(row.kind, 'new_device');
  assert.equal(row.summary, 'New device 10.20.0.57 (00:1b:1b:12:34:56 · Siemens) seen by PLC gateway at Plant A');
  // Not folded into the event the agent happens to have open, and two new
  // devices stay two rows.
  const second = { ...finding, id: 'f2', evidence: [{ labels: { ip: '10.20.0.58', mac: '00:30:de:00:00:01' } }] };
  const event = { timestamp: at.toISOString(), source: 'event', type: 'event.open', severity: 'WARN', summary: 'e', ref_id: 77, kind: 'event', count: 1, findingCount: 0, refIds: [77], firstAt: at.toISOString() };
  const feed = buildChangeFeed([...fromFindings([finding, second], { nameFor: () => 'PLC gateway' }), event], {
    from: new Date('2026-09-23T00:00:00Z'), to: new Date('2026-09-23T23:00:00Z'),
  });
  assert.equal(feed.events.filter((e) => e.kind === 'new_device').length, 2);
});

test('changes feed: an ordinary finding is unchanged', () => {
  const [row] = fromFindings([{ id: 'x', hostId: '9', metric: 'latency', severity: 'WARN', createdAt: new Date() }], { nameFor: () => 'a' });
  assert.equal(row.kind, 'finding');
});
