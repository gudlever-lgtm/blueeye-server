'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// What the agent already read off a switch and the server threw away (audit,
// section 2.3): the port's DUPLEX, the late-collision RATE, the VLAN names and
// sysDescr. Each is stored now (migrations 116 and 117), exposed through the
// routes that already existed, and — for duplex — turned into the one finding
// it makes possible: half duplex with late collisions or FCS errors climbing is
// a duplex mismatch.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeAgentTokensRepo, makeSnmpDevicesRepo, makeDeviceInterfacesRepo,
  makeCounterSamplesRepo, makeFindingStore, makeDispatcher, makeFdbEntriesRepo, authHeader,
} = require('../test-support/fakes');
const { computeSample } = require('../src/devices/counterDelta');
const { extractDeviceSamples, METRICS } = require('../src/analysis/deviceIngest');
const { detectDuplexMismatch } = require('../src/devices/duplexMismatch');
const { validateDeviceTopology, validateDeviceCounters } = require('../src/validation/snmpDeviceValidation');
const { metricFamily } = require('../src/changes/indications');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
const agentsRepo = () => makeAgentsRepo({
  findAll: async () => ([{ id: 9, hostname: 'be-aarhus-01' }]),
  findById: async () => ({ id: 9, hostname: 'be-aarhus-01' }),
});
const get = (app, path, role = 'viewer') => request(app).get(path).set('Authorization', authHeader(role));

async function seeded() {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({
    agentId: 9, host: '10.14.0.11', displayName: 'sw-core-1', collect: ['if', 'fdb', 'ifcounters'], counterIntervalSec: 60,
  });
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  await deviceInterfacesRepo.upsertMany(1, [{ ifName: 'Fa0/7', ifIndex: 7, speedMbps: 100, operStatus: 'up' }]);
  const deps = {
    snmpDevicesRepo,
    deviceInterfacesRepo,
    counterSamplesRepo: makeCounterSamplesRepo(),
    findingStore: makeFindingStore(),
    dispatcher: makeDispatcher(),
    fdbEntriesRepo: makeFdbEntriesRepo(),
  };
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), ...deps });
  return { app, ...deps };
}

const NOW = Date.now();
const T0 = new Date(NOW - 5 * 60 * 1000).toISOString();
const T1 = new Date(NOW - 4 * 60 * 1000).toISOString();

const IF = (over = {}) => ({
  ifIndex: 7, ifName: 'Fa0/7', inOctets: 1000, outOctets: 1000,
  fcsErrors: 0, lateCollisions: 0, duplex: 'full', ...over,
});
const counters = (app, readAt, iface, ticks) => request(app)
  .post('/agents/me/snmp-counters')
  .set('Authorization', 'Bearer agent-tok')
  .send({ devices: [{ deviceId: 1, readAt, sysUpTimeTicks: ticks, hc: true, interfaces: [iface] }] });

// =================================================================== the rate
test('late collisions become a RATE, voided by the same discontinuities as FCS', () => {
  const prev = { lateCollisions: 100, fcsErrors: 0 };
  const s = computeSample({ current: { lateCollisions: 160, fcsErrors: 0 }, previous: prev, elapsedSec: 60 });
  assert.equal(s.lateCollPps, 1);
  const rebooted = computeSample({ current: { lateCollisions: 5 }, previous: prev, elapsedSec: 60, rebooted: true });
  assert.equal(rebooted.lateCollPps, null);
  assert.equal(rebooted.discontinuity, 'reboot');
});

test('duplex is a STATE: it survives a discontinuity, and a garbage value is no answer', () => {
  const first = computeSample({ current: { duplex: 'half' } });
  assert.equal(first.discontinuity, 'first');
  assert.equal(first.duplex, 'half', 'a first sample still knows the port is half duplex');
  assert.equal(computeSample({ current: { duplex: 'sideways' } }).duplex, null);
  assert.equal(computeSample({ current: {} }).duplex, null, 'absent is not "full"');
});

test('the late-collision rate reaches the detector, under a name that classifies as an INTERFACE fault', () => {
  assert.ok(METRICS.some(([field]) => field === 'lateCollPps'));
  const out = extractDeviceSamples({
    ts: T1, deviceId: 1, interfaceId: 12, lateCollPps: 0.5, discontinuity: null,
  }, { hostId: '9' });
  const s = out.find((x) => x.metric === 'if.12.duplex.collPps');
  assert.ok(s, out.map((x) => x.metric).join(','));
  assert.equal(s.value, 0.5);
  // A metric spelled with "late" would read as LATENCY (/lat/) in the feed and
  // the event guide — the wrong advice for a cabling/duplex fault.
  assert.equal(metricFamily(s.metric), 'interface');
});

// ============================================================ duplex, stored
test('duplex is stored with the sample and exposed by GET /counters', async () => {
  const { app, counterSamplesRepo } = await seeded();
  await counters(app, T0, IF({ duplex: 'half' }), 500_000);
  assert.equal(counterSamplesRepo.rows[0].duplex, 'half');

  const res = await get(app, '/api/snmp-devices/1/counters');
  assert.equal(res.status, 200);
  assert.equal(res.body.counters[0].duplex, 'half');
});

// =================================================== the duplex-mismatch finding
test('half duplex with late collisions rising is a duplex-mismatch finding that names the port', async () => {
  const { app, findingStore, dispatcher } = await seeded();
  await counters(app, T0, IF({ duplex: 'half', lateCollisions: 10 }), 500_000);
  const res = await counters(app, T1, IF({ duplex: 'half', lateCollisions: 70 }), 506_000);
  assert.equal(res.status, 202);

  const f = findingStore.rows.find((x) => /duplex\.mismatch$/.test(x.metric));
  assert.ok(f, 'the mismatch is raised');
  assert.equal(f.severity, 'WARN');
  assert.match(f.explanation, /Fa0\/7/);
  assert.match(f.explanation, /sw-core-1/);
  assert.match(f.explanation, /HALF duplex/);
  assert.match(f.explanation, /late collisions \(1\/s\)/);
  assert.equal(metricFamily(f.metric), 'interface');
  assert.ok(dispatcher.calls.some((c) => c.finding.metric === f.metric), 'it reaches alerting');

  // Once per port per refractory period: a mismatch lasts until somebody
  // changes a setting.
  const T2 = new Date(NOW - 3 * 60 * 1000).toISOString();
  await counters(app, T2, IF({ duplex: 'half', lateCollisions: 130 }), 512_000);
  assert.equal(findingStore.rows.filter((x) => /duplex\.mismatch$/.test(x.metric)).length, 1);
});

test('FCS errors on a half-duplex port are the indicator too', () => {
  assert.ok(detectDuplexMismatch({ duplex: 'half', fcsPps: 0.2, lateCollPps: 0, discontinuity: null }));
});

test('a FULL duplex port with FCS errors is a cable question, not a duplex one', () => {
  assert.equal(detectDuplexMismatch({ duplex: 'full', fcsPps: 3, lateCollPps: null, discontinuity: null }), null);
  assert.equal(detectDuplexMismatch({ duplex: 'half', fcsPps: 0, lateCollPps: 0, discontinuity: null }), null,
    'half duplex with clean counters is a hub, not a fault');
  assert.equal(detectDuplexMismatch({ duplex: 'half', lateCollPps: null, fcsPps: null, discontinuity: 'first' }), null);
});

// ================================================================== validation
test('the validator keeps sysDescr (optional) and drops anything that is not a string', () => {
  assert.equal(validateDeviceTopology({ deviceId: 1, sysDescr: '  Cisco IOS 15.2(7)E3  ' }).sysDescr, 'Cisco IOS 15.2(7)E3');
  assert.equal(validateDeviceTopology({ deviceId: 1 }).sysDescr, null, 'an older agent sends none');
  assert.equal(validateDeviceTopology({ deviceId: 1, sysDescr: 42 }).sysDescr, null);
  assert.equal(validateDeviceTopology({ deviceId: 1, sysDescr: 'x'.repeat(400) }).sysDescr.length, 255);
  assert.equal(validateDeviceCounters({
    deviceId: 1, readAt: T0, interfaces: [{ ifName: 'Fa0/7', duplex: 'half' }],
  }).interfaces[0].duplex, 'half');
});

// ================================================== VLAN names and sysDescr
test('VLAN names and sysDescr from a topology poll are stored and returned by the device detail route', async () => {
  const { app, fdbEntriesRepo } = await seeded();
  const poll = (body) => request(app)
    .post('/agents/me/snmp-topology')
    .set('Authorization', 'Bearer agent-tok')
    .send({ devices: [{ deviceId: 1, fdb: [], ...body }] });

  const res = await poll({
    sysDescr: 'Cisco IOS Software, C2960X Software, Version 15.2(7)E3',
    vlans: [{ vlan: 20, name: 'Voice' }, { vlan: 10, name: 'Data' }],
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.vlanRows, 2);
  assert.equal(fdbEntriesRepo.vlans.length, 2);

  const detail = await get(app, '/api/snmp-devices/1');
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.vlans.map((v) => [v.vlan, v.name]), [[10, 'Data'], [20, 'Voice']]);
  assert.equal(detail.body.device.sysDescr, 'Cisco IOS Software, C2960X Software, Version 15.2(7)E3');

  // An OLDER agent sends neither. It must not erase what a newer one read, and
  // a sweep without VLAN names must not delete the names.
  await poll({});
  const again = await get(app, '/api/snmp-devices/1');
  assert.equal(again.body.device.sysDescr, 'Cisco IOS Software, C2960X Software, Version 15.2(7)E3');
  assert.equal(again.body.vlans.length, 2);

  // A renamed VLAN is renamed, not duplicated.
  await poll({ vlans: [{ vlan: 20, name: 'Voice-2' }] });
  const renamed = await get(app, '/api/snmp-devices/1');
  assert.equal(renamed.body.vlans.find((v) => v.vlan === 20).name, 'Voice-2');
  assert.equal(renamed.body.vlans.length, 2);
});

test('the device detail route still answers 400 / 401 / 404, and a VLAN read that fails costs nothing', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11' });
  const app = makeApp({
    agentsRepo: agentsRepo(), snmpDevicesRepo,
    fdbEntriesRepo: makeFdbEntriesRepo({ listVlans: async () => { throw new Error('db down'); } }),
  });
  assert.equal((await get(app, '/api/snmp-devices/abc')).status, 400);
  assert.equal((await request(app).get('/api/snmp-devices/1')).status, 401);
  assert.equal((await get(app, '/api/snmp-devices/99')).status, 404);
  const ok = await get(app, '/api/snmp-devices/1');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.vlans, []);
});

test('VLAN names age out with the forwarding table', async () => {
  const repo = makeFdbEntriesRepo();
  await repo.upsertVlans(1, [{ vlan: 10, name: 'Data' }], { at: new Date('2026-01-01T00:00:00Z') });
  await repo.upsertVlans(1, [{ vlan: 20, name: 'Voice' }], { at: new Date() });
  assert.equal(await repo.purgeVlansBefore(new Date(Date.now() - 24 * 3600 * 1000)), 1);
  assert.deepEqual((await repo.listVlans(1)).map((v) => v.vlan), [20]);
});
