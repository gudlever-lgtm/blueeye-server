'use strict';

// sFlow counter samples -> device counter series (src/devices/sflowCounterIngest.js).
//
// The rules under test are the ones that decide WHEN a number is written:
// only for an exporter that is a registered device, never over a device the
// SNMP counter poll already owns, never twice for the same reading, and with
// the same rate/discontinuity arithmetic as the SNMP path (counterDelta.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createSflowCounterIngest, normaliseEntry, canonicalIp, IF_FIELDS, ETH_FIELDS,
} = require('../src/devices/sflowCounterIngest');
const {
  makeSnmpDevicesRepo, makeDeviceInterfacesRepo, makeCounterSamplesRepo, makeSflowExportersRepo,
} = require('../test-support/fakes');

const T0 = Date.parse('2026-09-24T10:00:00Z');

// One agent entry, in the wire shape (blueeye-agent PROTOCOL.md).
function entry(over = {}) {
  const ifv = IF_FIELDS.map(() => 0);
  const eth = ETH_FIELDS.map(() => 0);
  const set = (arr, fields, vals) => { for (const [k, v] of Object.entries(vals || {})) arr[fields.indexOf(k)] = v; };
  set(ifv, IF_FIELDS, { ifInOctets: 1_000_000, ifOutOctets: 2_000_000, ...(over.if || {}) });
  set(eth, ETH_FIELDS, over.eth || {});
  const e = {
    agent: '10.14.0.2', ifIndex: 7, at: T0, uptimeMs: 1_000_000,
    ifType: 6, speed: 1e9, direction: 1, status: 3, if: ifv, eth, ...over,
  };
  e.if = ifv;
  e.eth = eth;
  if (over.noEth) delete e.eth;
  return e;
}

async function setup({ device = {}, clock = { t: T0 } } = {}) {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  const dev = await snmpDevicesRepo.create({ host: '10.14.0.2', displayName: 'edge-sw', collect: ['if'], ...device });
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const counterSamplesRepo = makeCounterSamplesRepo();
  const sflowExportersRepo = makeSflowExportersRepo();
  const emitted = [];
  const analysed = [];
  const ingest = createSflowCounterIngest({
    snmpDevicesRepo,
    deviceInterfacesRepo,
    counterSamplesRepo,
    sflowExportersRepo,
    analysisPipeline: { processDeviceSamples: async (hostId, rows) => { analysed.push({ hostId, rows }); return []; } },
    findingSink: { emit: async (f) => { emitted.push(f); return true; } },
    now: () => new Date(clock.t),
  });
  return { ingest, dev, snmpDevicesRepo, deviceInterfacesRepo, counterSamplesRepo, sflowExportersRepo, emitted, analysed, clock };
}

// ---------------------------------------------------------------- mapping
test('canonicalIp: IPv4 as-is, IPv6 compressed, a name is not an address', () => {
  assert.equal(canonicalIp('10.0.0.1'), '10.0.0.1');
  assert.equal(canonicalIp('2001:DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(canonicalIp('sw-1.lan'), null);
  assert.equal(canonicalIp(''), null);
});

test('normaliseEntry maps the sFlow arrays onto the counter fields, duplex from ifDirection', () => {
  const e = normaliseEntry(entry({
    direction: 2,
    if: { ifInErrors: 5, ifOutDiscards: 6, ifInBroadcastPkts: 9 },
    eth: { dot3StatsFCSErrors: 11, dot3StatsLateCollisions: 12, dot3StatsAlignmentErrors: 13, dot3StatsCarrierSenseErrors: 14 },
  }), T0);
  assert.equal(e.current.inOctets, 1_000_000);
  assert.equal(e.current.inErrors, 5);
  assert.equal(e.current.outDiscards, 6);
  assert.equal(e.current.inBcastPkts, 9);
  assert.equal(e.current.fcsErrors, 11);
  assert.equal(e.current.lateCollisions, 12);
  assert.equal(e.current.alignmentErrors, 13);
  assert.equal(e.current.carrierSenseErrors, 14);
  assert.equal(e.current.duplex, 'half');
  assert.equal(e.speedMbps, 1000);
  assert.deepEqual([e.adminStatus, e.operStatus], ['up', 'up']);
  assert.equal(normaliseEntry(entry({ direction: 1 }), T0).current.duplex, 'full');
  assert.equal(normaliseEntry(entry({ direction: 0 }), T0).current.duplex, 'unknown');
  assert.equal(normaliseEntry(entry({ direction: 3 }), T0).current.duplex, null, 'in/out-only is not a duplex');
});

test('normaliseEntry: a null counter stays null; junk entries are refused; an implausible time is "now"', () => {
  const e = normaliseEntry({ ...entry(), if: [null, ...IF_FIELDS.slice(1).map(() => 1)] }, T0);
  assert.equal(e.current.inOctets, null, 'absent is not zero');
  for (const bad of [null, {}, { agent: 'sw.lan', ifIndex: 1, if: [] }, { agent: '10.0.0.1', ifIndex: 0, if: [] },
    { agent: '10.0.0.1', ifIndex: 3 }]) {
    assert.equal(normaliseEntry(bad, T0), null, JSON.stringify(bad));
  }
  assert.equal(normaliseEntry(entry({ at: T0 - 3600_000 }), T0).at, T0);
  assert.equal(normaliseEntry(entry({ at: T0 + 3600_000 }), T0).at, T0);
  assert.equal(normaliseEntry(entry({ at: new Date(T0 - 30_000).toISOString() }), T0).at, T0 - 30_000);
});

// ---------------------------------------------------------------- ingest
test('a registered sFlow-only switch gets samples, rates and a minimal interface row', async () => {
  const s = await setup();
  const r1 = await s.ingest.ingest(1, [entry()]);
  assert.equal(r1.devices, 1);
  assert.equal(r1.interfacesCreated, 1);
  assert.equal(r1.samples, 1);
  assert.deepEqual(r1.discontinuities, { first: 1 });
  const port = s.deviceInterfacesRepo.rows[0];
  assert.equal(port.if_name, 'ifIndex 7');
  assert.equal(port.name_source, 'ifIndex');
  assert.equal(port.speed_mbps, 1000);

  s.clock.t = T0 + 60_000;
  const r2 = await s.ingest.ingest(1, [entry({ at: T0 + 60_000, uptimeMs: 1_060_000, if: { ifInOctets: 1_750_000, ifInErrors: 30 } })]);
  assert.equal(r2.samples, 1);
  assert.equal(r2.interfacesCreated, 0, 'the row is reused');
  const last = s.counterSamplesRepo.rows[1];
  assert.equal(last.discontinuity, null);
  assert.equal(last.inBps, 100_000, '750 000 bytes in 60 s');
  assert.equal(last.inErrPps, 0.5);
  assert.equal(last.duplex, 'full');
  assert.equal(s.analysed.length, 2, 'the samples reach the same analysis as SNMP counters');
  assert.equal(s.analysed[1].rows[0].ifName, 'ifIndex 7');
  // The device clock moves, for the next reboot check.
  const dev = (await s.snmpDevicesRepo.list({}))[0];
  assert.equal(dev.lastUptimeTicks, 106_000);
});

test('an existing (named) interface row is used, never a minimal duplicate', async () => {
  const s = await setup();
  await s.deviceInterfacesRepo.upsertMany(s.dev.id, [{ ifName: 'Gi1/0/7', ifIndex: 7, speedMbps: 100 }]);
  const r = await s.ingest.ingest(1, [entry()]);
  assert.equal(r.interfacesCreated, 0);
  assert.equal(s.deviceInterfacesRepo.rows.length, 1);
  assert.equal(s.counterSamplesRepo.rows[0].interfaceId, s.deviceInterfacesRepo.rows[0].id);
});

test('half duplex with rising late collisions raises the duplex-mismatch finding', async () => {
  const s = await setup();
  await s.ingest.ingest(1, [entry({ direction: 2 })]);
  s.clock.t = T0 + 60_000;
  await s.ingest.ingest(1, [entry({ direction: 2, at: T0 + 60_000, uptimeMs: 1_060_000, eth: { dot3StatsLateCollisions: 120 } })]);
  assert.equal(s.emitted.length, 1);
  assert.match(s.emitted[0].metric, /duplex\.mismatch$/);
  assert.match(s.emitted[0].explanation, /HALF duplex/);
  assert.match(s.emitted[0].explanation, /edge-sw/);
});

test('a reboot (exporter uptime went backwards) voids the rates for that reading', async () => {
  const s = await setup();
  await s.ingest.ingest(1, [entry()]);
  s.clock.t = T0 + 60_000;
  const r = await s.ingest.ingest(1, [entry({ at: T0 + 60_000, uptimeMs: 5_000, if: { ifInOctets: 10 } })]);
  assert.deepEqual(r.discontinuities, { reboot: 1 });
  assert.equal(s.counterSamplesRepo.rows[1].inBps, null);
});

test('the same reading twice (two collectors, a resubmit) is not a second sample', async () => {
  const s = await setup();
  await s.ingest.ingest(1, [entry()]);
  const r = await s.ingest.ingest(2, [entry({ at: T0 + 2000 })]);
  assert.equal(r.samples, 0);
  assert.equal(r.skipped.duplicate, 1);
  assert.equal(s.counterSamplesRepo.rows.length, 1);
});

test('a device the SNMP counter poll owns is left to it (no interleaved series)', async () => {
  const s = await setup({ device: { agentId: 3, collect: ['if', 'ifcounters'], counterIntervalSec: 60 } });
  const r = await s.ingest.ingest(1, [entry()]);
  assert.equal(r.samples, 0);
  assert.equal(r.skipped.snmpPolled, 1);
  assert.equal(s.sflowExportersRepo.rows[0].deviceId, s.dev.id, 'still recorded as a registered exporter');
});

test('a disabled device is skipped', async () => {
  const s = await setup({ device: { enabled: false } });
  const r = await s.ingest.ingest(1, [entry()]);
  assert.equal(r.skipped.disabled, 1);
  assert.equal(s.counterSamplesRepo.rows.length, 0);
});

test('an exporter that is no device stores nothing and is recorded as unregistered', async () => {
  const s = await setup();
  const r = await s.ingest.ingest(1, [entry({ agent: '10.99.0.1' }), entry({ agent: '10.99.0.1', ifIndex: 8 })]);
  assert.equal(r.unregistered, 1);
  assert.equal(s.counterSamplesRepo.rows.length, 0);
  assert.deepEqual(
    s.sflowExportersRepo.rows.map((x) => [x.agentId, x.address, x.deviceId, x.interfaces]),
    [[1, '10.99.0.1', null, 2]],
  );
});

test('a device registered by IPv6 matches an exporter reported in the long form', async () => {
  const s = await setup({ device: { host: '2001:db8::2' } });
  const r = await s.ingest.ingest(1, [entry({ agent: '2001:db8:0:0:0:0:0:2' })]);
  assert.equal(r.devices, 1);
  assert.equal(r.samples, 1);
});

test('processResults reads traffic.sflowCounters from every result; none -> null', async () => {
  const s = await setup();
  assert.equal(await s.ingest.processResults(1, [{ traffic: { source: 'sflow', flows: [] } }]), null);
  assert.equal(await s.ingest.processResults(1, null), null);
  const r = await s.ingest.processResults(1, [
    { traffic: { sflowCounters: [entry()] } },
    { traffic: { sflowCounters: [entry({ ifIndex: 8 })] } },
  ]);
  assert.equal(r.samples, 2);
});

test('one device failing does not stop the others, and the report says which', async () => {
  const s = await setup();
  await s.snmpDevicesRepo.create({ host: '10.14.0.3', collect: ['if'] });
  const orig = s.counterSamplesRepo.latestForDevice;
  s.counterSamplesRepo.latestForDevice = async (id, opts) => {
    if (id === s.dev.id) throw new Error('boom');
    return orig(id, opts);
  };
  const ingest = createSflowCounterIngest({
    snmpDevicesRepo: s.snmpDevicesRepo,
    deviceInterfacesRepo: s.deviceInterfacesRepo,
    counterSamplesRepo: s.counterSamplesRepo,
    now: () => new Date(T0),
  });
  const r = await ingest.ingest(1, [entry(), entry({ agent: '10.14.0.3' })]);
  assert.equal(r.devices, 1);
  assert.deepEqual(r.deviceErrors, [{ deviceId: s.dev.id, error: 'boom' }]);
});

test('an unreadable device list costs the report its counters, not an exception', async () => {
  const ingest = createSflowCounterIngest({
    snmpDevicesRepo: { list: async () => { throw new Error('db down'); } },
    deviceInterfacesRepo: makeDeviceInterfacesRepo(),
    counterSamplesRepo: makeCounterSamplesRepo(),
    now: () => new Date(T0),
  });
  const r = await ingest.ingest(1, [entry()]);
  assert.equal(r.samples, 0);
});
