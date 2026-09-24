'use strict';

// sFlow placeholder interface rows (`ifIndex N`, name_source 'ifIndex') and the
// real port an SNMP inventory later names with the same ifIndex.
//
// Before: idMapForDevice().byIndex kept whichever row MySQL returned last, so
// SNMP counters resolved by index could land on the placeholder, and the
// placeholder stayed next to the real row forever. Now byIndex prefers the
// real-named row, and the topology upsert retires the placeholder (if_index
// cleared, row and its samples kept — see deviceInterfacesRepository).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceInterfacesRepository } = require('../src/repositories/deviceInterfacesRepository');
const { createSflowCounterIngest, IF_FIELDS } = require('../src/devices/sflowCounterIngest');
const {
  makeSnmpDevicesRepo, makeDeviceInterfacesRepo, makeCounterSamplesRepo,
} = require('../test-support/fakes');

function scriptedPool(handler) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return handler(sql, params); } };
}

const AT = new Date('2026-09-24T10:00:00Z');

// ------------------------------------------------------------ idMapForDevice
test('idMapForDevice: a real-named row wins the ifIndex over a placeholder, whatever the row order', async () => {
  const placeholder = { id: 5, if_name: 'ifIndex 3', if_index: 3, name_source: 'ifIndex' };
  const real = { id: 9, if_name: 'Gi0/3', if_index: 3, name_source: 'ifName' };
  const other = { id: 7, if_name: 'Gi0/4', if_index: 4, name_source: 'ifDescr' };
  for (const order of [[placeholder, real, other], [real, placeholder, other], [other, placeholder, real]]) {
    const pool = scriptedPool(() => [order]);
    const { byName, byIndex } = await createDeviceInterfacesRepository({ pool }).idMapForDevice(1);
    assert.equal(byIndex.get(3), 9, 'the real port, never the placeholder');
    assert.equal(byIndex.get(4), 7);
    assert.equal(byName.get('ifIndex 3'), 5, 'the placeholder is still reachable by its own name');
    assert.match(pool.calls[0].sql, /SELECT id, if_name, if_index, name_source FROM device_interfaces WHERE device_id = \? ORDER BY id/);
  }
});

test('idMapForDevice: two real rows on one index (mid-renumber) resolve to the lowest id, deterministically', async () => {
  const pool = scriptedPool(() => [[
    { id: 3, if_name: 'Gi0/1', if_index: 10, name_source: 'ifName' },
    { id: 8, if_name: 'Gi0/2', if_index: 10, name_source: 'ifName' },
  ]]);
  const { byIndex } = await createDeviceInterfacesRepository({ pool }).idMapForDevice(1);
  assert.equal(byIndex.get(10), 3);
});

// ------------------------------------------------------ upsertMany retirement
function upsertPool({ updated = 1 } = {}) {
  return scriptedPool((sql) => {
    if (/^SELECT/.test(sql)) return [[]];
    if (/^INSERT/.test(sql)) return [{ affectedRows: 2 }];
    if (/^UPDATE/.test(sql)) return [{ affectedRows: updated }];
    throw new Error(`unexpected ${sql}`);
  });
}

test('upsertMany: a real-named port retires the placeholder holding its ifIndex (if_index cleared, row kept)', async () => {
  const pool = upsertPool();
  const out = await createDeviceInterfacesRepository({ pool }).upsertMany(4, [
    { ifName: 'Gi0/3', ifIndex: 3, nameSource: 'ifName' },
    { ifName: 'Gi0/4', ifIndex: 4 }, // nameSource defaults to ifName
    { ifName: 'Gi0/5', ifIndex: null }, // no index: nothing to retire for it
  ], { at: AT });
  assert.equal(out.retired, 1);
  const upd = pool.calls.find((c) => /^UPDATE/.test(c.sql));
  assert.ok(upd, 'a retire statement was issued');
  assert.match(upd.sql, /SET if_index = NULL, if_index_changed_at = \?/);
  assert.match(upd.sql, /WHERE device_id = \? AND name_source = 'ifIndex'\s+AND if_index IN \(\?\) AND if_name NOT IN \(\?\)/);
  assert.doesNotMatch(upd.sql, /DELETE/, 'the row and its history are kept');
  assert.deepEqual(upd.params, [AT, 4, [3, 4], ['Gi0/3', 'Gi0/4', 'Gi0/5']]);
});

test('upsertMany: a batch of placeholders only (the sFlow ingest creating them) retires nothing', async () => {
  const pool = upsertPool();
  const out = await createDeviceInterfacesRepository({ pool }).upsertMany(4, [
    { ifName: 'ifIndex 3', ifIndex: 3, nameSource: 'ifIndex' },
  ], { at: AT });
  assert.equal(out.retired, 0);
  assert.equal(pool.calls.some((c) => /^UPDATE/.test(c.sql)), false, 'no statement at all');
});

// ------------------------------------------------------------- end to end
const counters = (ifIndex, at, octets) => ({
  agent: '10.14.0.2', ifIndex, at, uptimeMs: 5_000_000 + (at - Date.parse('2026-09-24T10:00:00Z')), speed: 1e9, direction: 1, status: 3,
  if: IF_FIELDS.map((f) => (f === 'ifInOctets' || f === 'ifOutOctets' ? octets : 0)),
});

test('end to end: placeholder first, SNMP names the port, later sFlow counters land on the real row', async () => {
  const clock = { t: AT.getTime() };
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  const dev = await snmpDevicesRepo.create({ host: '10.14.0.2', collect: ['if'] });
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const counterSamplesRepo = makeCounterSamplesRepo();
  const ingest = createSflowCounterIngest({
    snmpDevicesRepo, deviceInterfacesRepo, counterSamplesRepo, now: () => new Date(clock.t),
  });

  // 1. sFlow only: a placeholder row and its first sample.
  await ingest.ingest(1, [counters(3, clock.t, 1000)]);
  const ph = deviceInterfacesRepo.rows.find((r) => r.if_name === 'ifIndex 3');
  assert.ok(ph && ph.name_source === 'ifIndex' && ph.if_index === 3);
  assert.equal(counterSamplesRepo.rows.filter((r) => r.interfaceId === ph.id).length, 1);

  // 2. An SNMP topology poll inventories the same port under its real name.
  clock.t += 60_000;
  const out = await deviceInterfacesRepo.upsertMany(dev.id, [{ ifName: 'Gi0/3', ifIndex: 3, speedMbps: 1000 }], { at: new Date(clock.t) });
  assert.equal(out.retired, 1);
  const real = deviceInterfacesRepo.rows.find((r) => r.if_name === 'Gi0/3');
  assert.equal(ph.if_index, null, 'the placeholder no longer holds the index');
  assert.ok(deviceInterfacesRepo.rows.includes(ph), 'but is kept');
  assert.equal((await deviceInterfacesRepo.idMapForDevice(dev.id)).byIndex.get(3), real.id);

  // 3. The next sFlow counters for ifIndex 3 go to the real port; no new placeholder.
  clock.t += 60_000;
  await ingest.ingest(1, [counters(3, clock.t, 2000)]);
  assert.equal(counterSamplesRepo.rows.filter((r) => r.interfaceId === real.id).length, 1);
  assert.equal(counterSamplesRepo.rows.filter((r) => r.interfaceId === ph.id).length, 1, 'the placeholder keeps its own history');
  assert.equal(deviceInterfacesRepo.rows.filter((r) => r.name_source === 'ifIndex').length, 1, 'no second placeholder');
});
