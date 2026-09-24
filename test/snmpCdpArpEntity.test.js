'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// The SNMP topology poll's extensions (migrations 124-126), end to end on the
// server side: CDP neighbours beside LLDP, a router's ARP table (IP-MIB) as an
// identity source, the ENTITY-MIB inventory, and sysLocation/sysContact/
// sysObjectID — through validation, storage, the API, search, the new-device
// detector, retention, coverage and the topology graph.
//
// The payloads below are shaped exactly as the agent's buildTopology emits
// them (see blueeye-agent test/snmpTopologyExtensions.test.js, which decodes
// them from net-snmp varbinds).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeAgentTokensRepo, makeSnmpDevicesRepo, makeSnmpNeighborsRepo,
  makeDeviceArpRepo, makeArpEntriesRepo, makeLocationsRepo, makeTopologyChangesRepo, authHeader,
} = require('../test-support/fakes');
const {
  validateDeviceTopology, validateSnmpDevice, COLLECT_KINDS, DEFAULT_COLLECT, LEGACY_DEFAULT_COLLECT,
} = require('../src/validation/snmpDeviceValidation');
const { createSnmpDevicesRepository, mapRow: mapDeviceRow } = require('../src/repositories/snmpDevicesRepository');
const { createSnmpNeighborsRepository } = require('../src/repositories/snmpNeighborsRepository');
const { createDeviceArpEntriesRepository, UPSERT_CHUNK } = require('../src/repositories/deviceArpEntriesRepository');
const { createSnmpTopologyIngest } = require('../src/devices/snmpTopologyIngest');
const { createTopologyChangeService } = require('../src/topology/topologyChangeService');
const { createNewDeviceDetector, withDeviceArpDetection } = require('../src/discovery/newDeviceDetector');
const { createPurge } = require('../src/analysis/retention/purge');
const { buildCoverageReport } = require('../src/coverage/coverageGaps');
const { buildTopologyGraph } = require('../src/topology/graph');

function scriptedPool(answers = []) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(sql, params) {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next || [{ affectedRows: 1, insertId: 1 }];
      },
    },
  };
}

const agentToken = (agentId = 9) => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: agentId }) });
const agentsRepo = () => makeAgentsRepo({
  findAll: async () => ([{ id: 9, hostname: 'be-plant-01', display_name: 'Plant collector', location_id: 3 }]),
  findById: async (id) => (Number(id) === 9 ? { id: 9, hostname: 'be-plant-01', location_id: 3 } : null),
});
const locationsRepo = () => makeLocationsRepo({
  findAll: async () => [{ id: 3, name: 'Plant A' }],
  findById: async (id) => (Number(id) === 3 ? { id: 3, name: 'Plant A' } : null),
});

async function seededDevices() {
  const repo = makeSnmpDevicesRepo();
  await repo.create({ agentId: 9, host: '10.20.0.1', displayName: 'rtr-ot-1', community: 'c', locationId: 3 });
  return repo;
}

// What the agent sends for one router, every new field populated.
const ROUTER = (over = {}) => ({
  deviceId: 1,
  sysName: 'rtr-ot-1',
  sysDescr: 'Cisco IOS XE Software, ISR4331',
  sysLocation: 'Hal 2, tavlerum, rack A3',
  sysContact: 'OT-drift',
  sysObjectId: '1.3.6.1.4.1.9.1.2066',
  interfaces: [{ ifIndex: 20, ifName: 'Vlan20', nameSource: 'ifName' }],
  fdb: [],
  neighbours: [
    { protocol: 'lldp', localPort: 3, localIfIndex: 3, localIfName: 'Gi0/0/1', remoteChassisId: 'aa:bb:cc:11:22:33', remotePortId: 'Gi1/0/5', remoteSysName: 'sw-dist-1' },
    {
      protocol: 'cdp', localPort: 3, localIfIndex: 3, localIfName: 'Gi0/0/1', remoteChassisId: 'sw-dist-1', remotePortId: 'Gi1/0/5',
      remotePortDesc: null, remoteSysName: 'sw-dist-1', remoteAddress: '10.14.0.11', remotePlatform: 'cisco WS-C3850-48P',
    },
  ],
  arp: [
    { ip: '10.20.0.84', mac: '00:1b:44:11:3a:b7', ifIndex: 20, ifName: 'Vlan20' },
    { ip: '2001:db8::1', mac: '00:1b:44:11:3a:b7', ifIndex: 20, ifName: 'Vlan20' },
  ],
  arpSource: 'ipNetToPhysical',
  arpTruncated: false,
  arpTotal: 2,
  inventory: [
    { entIndex: 1, class: 'chassis', name: 'Chassis', model: 'ISR4331/K9', serial: 'FDO2201A0XY', vendor: 'Cisco Systems Inc', softwareRev: '16.12.04' },
    { entIndex: 1000, class: 'chassis', name: 'Switch 2', model: 'WS-C3850-48P', serial: 'FOC9999Z2EF' },
    { entIndex: 2, class: 'module', name: 'NIM', model: 'NIM-ES2-4', serial: 'FOC5678Y1CD' },
  ],
  supported: ['if', 'lldp', 'cdp', 'arp', 'entity'],
  ...over,
});

const post = (app, body) => request(app).post('/agents/me/snmp-topology').set('Authorization', 'Bearer agent-tok').send(body);
const get = (app, path, role = 'viewer') => request(app).get(path).set('Authorization', authHeader(role));

// ================================================================ validation
test('cdp, arp and entity are collect kinds; the NEW-device default includes them, the legacy one does not', () => {
  for (const k of ['cdp', 'arp', 'entity']) assert.ok(COLLECT_KINDS.includes(k), k);
  assert.deepEqual(DEFAULT_COLLECT, ['if', 'fdb', 'lldp', 'vlan', 'cdp', 'arp', 'entity']);
  assert.deepEqual(LEGACY_DEFAULT_COLLECT, ['if', 'fdb', 'lldp', 'vlan']);
  assert.deepEqual(validateSnmpDevice({ host: '10.1.1.1', collect: ['cdp', 'arp', 'entity'] }).value.collect, ['cdp', 'arp', 'entity']);
  assert.ok(validateSnmpDevice({ host: '10.1.1.1', collect: ['snmpwalk-everything'] }).errors.collect);
});

test('a device batch: CDP kept with its address, LLDP the default protocol, junk dropped', () => {
  const d = validateDeviceTopology(ROUTER({
    neighbours: [
      { remoteChassisId: 'old-agent-lldp' }, // an agent older than CDP sends no protocol
      { protocol: 'cdp', remoteChassisId: 'x', remoteAddress: '10.14.0.11' },
      { protocol: 'cdp', remoteChassisId: 'y', remoteAddress: 'not-an-ip' },
      { protocol: 'ospf', remoteChassisId: 'z' },
    ],
  }));
  assert.deepEqual(d.neighbours.map((n) => [n.remoteChassisId, n.protocol, n.remoteAddress]), [
    ['old-agent-lldp', 'lldp', null],
    ['x', 'cdp', '10.14.0.11'],
    ['y', 'cdp', null],
    ['z', 'lldp', null],
  ]);
});

test('a device batch: ARP rows validated, deduplicated per IP, bad ones counted', () => {
  const d = validateDeviceTopology(ROUTER({
    arp: [
      { ip: '10.20.0.84', mac: '00-1B-44-11-3A-B7', ifIndex: 20, ifName: 'Vlan20' }, // any spelling
      { ip: '10.20.0.84', mac: '00:1b:44:11:3a:b8' }, // the same IP twice
      { ip: '10.20.0.85', mac: 'ff:ff:ff:ff:ff:ff' }, // broadcast
      { ip: 'ten.twenty', mac: '00:1b:44:11:3a:b9' },
      { ip: '2001:DB8::1', mac: '00:1b:44:11:3a:ba', ifIndex: -4 },
      'junk',
    ],
  }));
  assert.deepEqual(d.arp, [
    { ip: '10.20.0.84', mac: '00:1b:44:11:3a:b7', ifIndex: 20, ifName: 'Vlan20' },
    { ip: '2001:db8::1', mac: '00:1b:44:11:3a:ba', ifIndex: null, ifName: null },
  ]);
  assert.equal(d.arpSkipped, 3);
});

test('a device batch: inventory rows and the system group', () => {
  const d = validateDeviceTopology(ROUTER({
    inventory: [...ROUTER().inventory, { entIndex: 0, class: 'chassis' }, { entIndex: 7, class: 'sensor' }],
    sysObjectId: 'enterprises.9',
  }));
  assert.deepEqual(d.inventory.map((e) => e.entIndex), [1, 1000, 2]);
  assert.equal(d.sysLocation, 'Hal 2, tavlerum, rack A3');
  assert.equal(d.sysContact, 'OT-drift');
  assert.equal(d.sysObjectId, null, 'an OID is dotted decimal');
});

test('an OLD agent payload validates with every new field empty — never an error', () => {
  const d = validateDeviceTopology({ deviceId: 1, fdb: [], neighbours: [{ remoteChassisId: 'sw-x' }] });
  assert.deepEqual(d.arp, []);
  assert.deepEqual(d.inventory, []);
  assert.equal(d.sysLocation, null);
  assert.equal(d.neighbours[0].protocol, 'lldp');
});

// ================================================================ end to end
test('a router cycle stores CDP beside LLDP, the ARP table, the inventory and sysLocation', async () => {
  const snmpDevicesRepo = await seededDevices();
  const snmpNeighborsRepo = makeSnmpNeighborsRepo();
  const deviceArpRepo = makeDeviceArpRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), locationsRepo: locationsRepo(),
    snmpDevicesRepo, snmpNeighborsRepo, deviceArpRepo,
  });

  const res = await post(app, { devices: [ROUTER()], errors: [] });
  assert.equal(res.status, 202);
  assert.equal(res.body.stored, 1);
  assert.equal(res.body.arpRows, 2);
  assert.equal(res.body.inventoryRows, 3);
  assert.equal(snmpNeighborsRepo.rows.length, 2, 'the LLDP and CDP rows of one neighbour are two rows');
  assert.deepEqual(snmpNeighborsRepo.rows.map((r) => r.protocol).sort(), ['cdp', 'lldp']);

  const page = await get(app, '/api/snmp-devices/1');
  assert.equal(page.status, 200);
  assert.equal(page.body.device.sysLocation, 'Hal 2, tavlerum, rack A3');
  assert.equal(page.body.device.sysContact, 'OT-drift');
  assert.equal(page.body.device.sysObjectId, '1.3.6.1.4.1.9.1.2066');
  assert.equal(page.body.device.hardware.model, 'ISR4331/K9', 'the FIRST chassis is the one the device is known by');
  assert.equal(page.body.device.hardware.serial, 'FDO2201A0XY');
  assert.equal(page.body.siteName, 'Plant A');
  assert.equal(page.body.arpTotal, 2);
  assert.deepEqual(page.body.arp.map((r) => r.ip).sort(), ['10.20.0.84', '2001:db8::1']);
  assert.deepEqual(page.body.inventory.map((e) => e.serial), ['FDO2201A0XY', 'FOC5678Y1CD', 'FOC9999Z2EF']);
  const cdp = page.body.neighbours.find((n) => n.protocol === 'cdp');
  assert.equal(cdp.remoteAddress, '10.14.0.11');
  assert.equal(cdp.remotePlatform, 'cisco WS-C3850-48P');

  // The list carries sysLocation too — the switch list shows it under the site.
  const list = await get(app, '/api/snmp-devices');
  assert.equal(list.body.devices[0].sysLocation, 'Hal 2, tavlerum, rack A3');
});

test('an older agent that sends none of it erases nothing', async () => {
  const snmpDevicesRepo = await seededDevices();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo });
  await post(app, { devices: [ROUTER()] });
  await post(app, { devices: [{ deviceId: 1, fdb: [], neighbours: [] }] });
  const d = await snmpDevicesRepo.findById(1);
  assert.equal(d.sysLocation, 'Hal 2, tavlerum, rack A3');
  assert.equal(d.hardware.serial, 'FDO2201A0XY');
  assert.equal((await snmpDevicesRepo.listInventory(1)).length, 3, 'an empty inventory is not a replace');
});

test('an ARP ingest failure costs the ARP table, not the poll', async () => {
  const snmpDevicesRepo = await seededDevices();
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo,
    deviceArpRepo: makeDeviceArpRepo({ upsertMany: async () => { throw new Error('deadlock'); } }),
  });
  const res = await post(app, { devices: [ROUTER()] });
  assert.equal(res.status, 202);
  assert.equal(res.body.stored, 1);
  assert.equal(res.body.arpRows, 0);
});

test('the device page still opens when the ARP and inventory reads fail', async () => {
  const snmpDevicesRepo = await seededDevices();
  snmpDevicesRepo.listInventory = async () => { throw new Error('gone'); };
  const app = makeApp({
    agentsRepo: agentsRepo(), snmpDevicesRepo,
    deviceArpRepo: makeDeviceArpRepo({ listForDevice: async () => { throw new Error('gone'); } }),
  });
  const res = await get(app, '/api/snmp-devices/1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.arp, []);
  assert.deepEqual(res.body.inventory, []);
});

test('the device page: 401 without a token, 404 for no such device, 400 for a bad id', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices() });
  assert.equal((await request(app).get('/api/snmp-devices/1')).status, 401);
  assert.equal((await get(app, '/api/snmp-devices/99')).status, 404);
  assert.equal((await get(app, '/api/snmp-devices/abc')).status, 400);
});

test('a NEW device gets the wide default collect; the API never widens an existing one', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo });
  const created = await request(app).post('/api/snmp-devices').set('Authorization', authHeader('admin'))
    .send({ host: '10.20.0.2' });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.device.collect, DEFAULT_COLLECT);
  // A display-name edit leaves collect alone.
  await snmpDevicesRepo.update(created.body.device.id, { collect: ['if', 'fdb'] });
  const patched = await request(app).patch(`/api/snmp-devices/${created.body.device.id}`)
    .set('Authorization', authHeader('admin')).send({ displayName: 'x' });
  assert.deepEqual(patched.body.device.collect, ['if', 'fdb']);
});

// ======================================================= the neighbour diff
test('a CDP walk that failed does not announce every CDP neighbour as removed', async () => {
  const snmpDevicesRepo = await seededDevices();
  const snmpNeighborsRepo = makeSnmpNeighborsRepo();
  const topologyChangesRepo = makeTopologyChangesRepo();
  const topologyChangeService = createTopologyChangeService({ topologyChangesRepo, lldpNeighborsRepo: { deleteEdge: async () => {} } });
  let t = new Date('2026-09-23T10:00:00Z');
  const ingest = createSnmpTopologyIngest({
    snmpDevicesRepo, snmpNeighborsRepo, fdbEntriesRepo: { upsertMany: async () => 0 },
    topologyChangeService, now: () => t,
  });
  const lldp = ROUTER().neighbours[0];
  const cdpA = { ...ROUTER().neighbours[1], localIfName: 'Gi0/0/2', remoteChassisId: 'ap-3', remotePortId: 'eth0' };
  const batch = (neighbours) => ({ devices: [validateDeviceTopology(ROUTER({ neighbours, arp: [], inventory: [] }))], failures: [] });

  await ingest.ingest(9, batch([lldp, cdpA])); // baseline
  t = new Date(t.getTime() + 300000);
  const r = await ingest.ingest(9, batch([lldp])); // CDP walk timed out
  assert.equal(r.neighbourChanges, 0, 'CDP neighbours were announced as removed');

  t = new Date(t.getTime() + 300000);
  const back = await ingest.ingest(9, batch([lldp, cdpA])); // CDP answers again
  assert.equal(back.neighbourChanges, 0, 'a CDP neighbour that never left was announced as added');

  t = new Date(t.getTime() + 300000);
  const gone = await ingest.ingest(9, batch([lldp])); // …and a real CDP loss, reported with LLDP present, still…
  assert.equal(gone.neighbourChanges, 0, '…is indistinguishable from a failed walk, and is not announced');
  const moved = await ingest.ingest(9, batch([lldp, { ...cdpA, localIfName: 'Gi0/0/9' }]));
  assert.equal(moved.neighbourChanges, 1, 'a CDP neighbour that moved port is still a change');
});

// ============================================================ repositories
test('snmp_neighbors upsert writes the protocol, the address and the platform', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createSnmpNeighborsRepository({ pool });
  await repo.upsertMany(4, [
    { remoteChassisId: 'a' },
    { protocol: 'cdp', remoteChassisId: 'b', remoteAddress: '10.1.1.1', remotePlatform: 'cisco' },
    { protocol: 'bogus', remoteChassisId: 'c' },
  ], { at: new Date() });
  assert.match(calls[0].sql, /\(device_id, protocol, local_port, .* remote_address, remote_platform, first_seen, last_seen\)/);
  assert.match(calls[0].sql, /remote_address = VALUES\(remote_address\)/);
  const p = calls[0].params;
  assert.equal(p.length, 39);
  assert.deepEqual([p[1], p[14], p[27]], ['lldp', 'cdp', 'lldp']);
  assert.deepEqual([p[22], p[23]], ['10.1.1.1', 'cisco']);
});

test('device_arp_entries: chunked upsert that stamps a moved binding, and the reads', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createDeviceArpEntriesRepository({ pool });
  const rows = Array.from({ length: UPSERT_CHUNK + 5 }, (_, i) => ({ ip: `10.0.${i >> 8}.${i & 255}`, mac: '00:1b:44:11:3a:b7' }));
  await repo.upsertMany(4, rows, { at: new Date() });
  assert.equal(calls.length, 2, 'one statement per chunk');
  assert.match(calls[0].sql, /mac_changed_at = IF\(mac <> VALUES\(mac\), VALUES\(last_seen\), mac_changed_at\)/);
  assert.equal(calls[1].params.length, 5 * 7);

  const q = scriptedPool([[[{ id: 1, device_id: 4, ip: '10.0.0.1', mac: 'm', if_index: 20, if_name: 'Vlan20', first_seen: new Date(), last_seen: new Date(), device_host: '10.20.0.1', device_name: 'rtr', device_location_id: 3, device_sys_location: 'rack A3' }]]]);
  const hits = await createDeviceArpEntriesRepository({ pool: q.pool }).findByIp({ ip: '10.0.0.1' });
  assert.match(q.calls[0].sql, /JOIN snmp_devices d ON d.id = a.device_id WHERE a.ip = \?/);
  assert.equal(hits[0].deviceSysLocation, 'rack A3');
  assert.equal(hits[0].ifName, 'Vlan20');

  const k = scriptedPool([[[{ mac: 'm' }]]]);
  const known = await createDeviceArpEntriesRepository({ pool: k.pool }).knownMacs({ macs: ['m', 'n'], locationId: 3 });
  assert.match(k.calls[0].sql, /WHERE d.location_id = \? AND a.mac IN \(\?\)/);
  assert.deepEqual([...known], ['m']);
  assert.equal((await createDeviceArpEntriesRepository({ pool: k.pool }).knownMacs({ macs: ['m'] })).size, 0,
    'no scope is no answer, never "every device"');
});

test('snmp_devices: create writes the wide default; a stored NULL still reads as the legacy list', async () => {
  const { pool, calls } = scriptedPool([[{ insertId: 7 }], [[]]]);
  const repo = createSnmpDevicesRepository({ pool });
  await repo.create({ host: '10.0.0.9' });
  assert.equal(calls[0].params[8], JSON.stringify(DEFAULT_COLLECT));
  assert.deepEqual(mapDeviceRow({ id: 1, port: 161, version: '2c', collect: null }).collect, LEGACY_DEFAULT_COLLECT);
});

test('snmp_devices: recordPoll keeps the system group and the hardware with COALESCE', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createSnmpDevicesRepository({ pool });
  await repo.recordPoll(1, {
    ok: true, sysName: 'sw-core-1', sysLocation: 'rack B', sysContact: 'noc', sysObjectId: '1.3.6.1.4.1.9',
    hardware: { vendor: 'Cisco', model: 'WS-C3850', serial: 'FOC1', softwareRev: '16.12' }, at: new Date(),
  });
  // sys_name (migration 133) sits after sys_descr, so every later parameter
  // moved one to the right.
  for (const col of ['sys_name', 'sys_location', 'sys_contact', 'sys_object_id', 'hw_vendor', 'hw_model', 'hw_serial', 'hw_rev', 'fw_rev', 'sw_rev']) {
    assert.match(calls[0].sql, new RegExp(`${col} = COALESCE\\(\\?, ${col}\\)`), col);
  }
  assert.deepEqual(calls[0].params.slice(4, 14), ['sw-core-1', 'rack B', 'noc', '1.3.6.1.4.1.9', 'Cisco', 'WS-C3850', 'FOC1', null, null, '16.12']);
});

test('device_inventory: replaced per poll on whole seconds, serial search escapes LIKE', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createSnmpDevicesRepository({ pool });
  const at = new Date('2026-09-23T10:00:05.678Z');
  await repo.replaceInventory(4, [{ entIndex: 1, class: 'chassis', serial: 'FOC1' }], { at });
  assert.match(calls[0].sql, /^INSERT INTO device_inventory/);
  assert.match(calls[1].sql, /^DELETE FROM device_inventory WHERE device_id = \? AND last_seen < \?/);
  const sec = new Date('2026-09-23T10:00:05.000Z');
  assert.deepEqual(calls[1].params, [4, sec], 'a fractional cutoff would delete what this poll just wrote');
  assert.deepEqual(calls[0].params.slice(-2), [sec, sec]);
  assert.equal(await repo.replaceInventory(4, []), 0);
  assert.equal(calls.length, 2, 'an empty report replaces nothing');

  const s = scriptedPool([[[]]]);
  await createSnmpDevicesRepository({ pool: s.pool }).findBySerial('FOC_1%');
  assert.deepEqual(s.calls[0].params, ['FOC\\_1\\%%', 10]);
});

// ================================================================== search
test('an IP only a ROUTER has seen is found, with the router, the SVI and where it is', async () => {
  const snmpDevicesRepo = await seededDevices();
  await snmpDevicesRepo.recordPoll(1, { ok: true, sysLocation: 'Hal 2, rack A3' });
  const deviceArpRepo = makeDeviceArpRepo();
  await deviceArpRepo.upsertMany(1, [{ ip: '10.30.0.7', mac: '00:80:f4:01:02:03', ifIndex: 30, ifName: 'Vlan30' }]);
  const app = makeApp({ agentsRepo: agentsRepo(), locationsRepo: locationsRepo(), snmpDevicesRepo, deviceArpRepo });

  const byIp = await get(app, '/api/search?q=10.30.0.7');
  const hit = byIp.body.hits.find((h) => h.source === 'device_arp_entries (snmp)');
  assert.ok(hit, JSON.stringify(byIp.body.hits));
  assert.equal(hit.type, 'ip');
  assert.equal(hit.display_name, '10.30.0.7 → 00:80:f4:01:02:03');
  assert.equal(hit.target, 'snmp-device:1');
  assert.equal(hit.confidence, 'exact');
  assert.match(hit.detail, /rtr-ot-1 on Vlan30/);
  assert.match(hit.detail, /Plant A · Hal 2, rack A3/);

  const byMac = await get(app, '/api/search?q=0080.f401.0203');
  const m = byMac.body.hits.find((h) => h.source === 'device_arp_entries (snmp)');
  assert.equal(m.display_name, '00:80:f4:01:02:03 → 10.30.0.7');
});

test('a device is found by serial — any stack member — by model and by its sysLocation', async () => {
  const snmpDevicesRepo = await seededDevices();
  await snmpDevicesRepo.recordPoll(1, { ok: true, sysLocation: 'Hal 2, rack A3', hardware: { model: 'ISR4331/K9', serial: 'FDO2201A0XY' } });
  await snmpDevicesRepo.replaceInventory(1, ROUTER().inventory);
  const app = makeApp({ agentsRepo: agentsRepo(), locationsRepo: locationsRepo(), snmpDevicesRepo });

  const primary = (await get(app, '/api/search?q=FDO2201A0XY')).body.hits.find((h) => h.target === 'snmp-device:1');
  assert.equal(primary.confidence, 'exact');
  assert.equal(primary.type, 'device');
  assert.match(primary.detail, /Plant A · Hal 2, rack A3/);

  const member = (await get(app, '/api/search?q=FOC9999Z2EF')).body.hits.find((h) => h.target === 'snmp-device:1');
  assert.ok(member, 'the second stack member\'s serial finds the stack');
  assert.equal(member.confidence, 'exact');
  assert.match(member.detail, /chassis serial FOC9999Z2EF \(Switch 2\)/);

  assert.ok((await get(app, '/api/search?q=isr4331')).body.hits.some((h) => h.target === 'snmp-device:1'));
  const rack = (await get(app, '/api/search?q=rack%20A3')).body.hits.find((h) => h.target === 'snmp-device:1');
  assert.equal(rack.confidence, 'medium');
  assert.match(rack.detail, /matched sysLocation/);
  // A substring of a serial is a coincidence, not a lead.
  assert.ok(!(await get(app, '/api/search?q=2201A0')).body.hits.some((h) => h.target === 'snmp-device:1'));
});

test('a failing router-ARP read costs that source, not the search', async () => {
  const app = makeApp({
    agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices(),
    deviceArpRepo: makeDeviceArpRepo({ findByIp: async () => { throw new Error('down'); } }),
  });
  const res = await get(app, '/api/search?q=10.30.0.7');
  assert.equal(res.status, 200);
  assert.ok(res.body.failedSources.includes('ip'));
});

// ==================================================== the new-device detector
const NOW = new Date('2026-09-23T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000);
const ROUTER_ROW = { id: 1, agentId: 9, host: '10.20.0.1', displayName: 'rtr-ot-1', locationId: 3, sysLocation: 'rack A3' };

function deviceDetector({ deviceArpRepo, arpEntriesRepo = null, baselineHours = 24 }) {
  const saved = [];
  const d = createNewDeviceDetector({
    deviceArpRepo,
    arpEntriesRepo,
    locationsRepo: locationsRepo(),
    findingStore: { async save(f) { saved.push(f); return { ...f }; } },
    config: { enabled: true, baselineHours, maxPerHour: 20, severity: 'WARN' },
    now: () => NOW,
  });
  return { d, saved };
}

async function observeRouter(d, repo, entries, device = ROUTER_ROW) {
  const pending = await d.checkDeviceArp(device, entries, { agentId: 9 });
  await repo.upsertMany(device.id, entries, { at: NOW });
  return d.raiseDeviceArp(pending);
}

test('ROUTER ARP: a router\'s first table is a baseline, not a flood', async () => {
  const repo = makeDeviceArpRepo({ deviceSite: { 1: 3 } });
  const { d, saved } = deviceDetector({ deviceArpRepo: repo });
  const first = Array.from({ length: 50 }, (_, i) => ({ ip: `10.30.0.${i + 1}`, mac: `00:80:f4:00:00:${String(i).padStart(2, '0')}` }));
  assert.deepEqual(await observeRouter(d, repo, first), []);
  assert.equal(saved.length, 0);
});

test('ROUTER ARP: a MAC new to the site is raised naming the router, the room and the SVI', async () => {
  const repo = makeDeviceArpRepo({ deviceSite: { 1: 3 } });
  await repo.upsertMany(1, [{ ip: '10.30.0.1', mac: '00:80:f4:00:00:01' }], { at: hoursAgo(48) });
  const { d, saved } = deviceDetector({ deviceArpRepo: repo });
  const out = await observeRouter(d, repo, [
    { ip: '10.30.0.1', mac: '00:80:f4:00:00:01' }, // known
    { ip: '10.30.0.99', mac: '00:1d:9c:12:34:56', ifName: 'Vlan30' }, // new
  ]);
  assert.equal(out.length, 1);
  const f = saved[0];
  assert.equal(f.metric, 'device.new');
  assert.equal(f.hostId, '9', 'the polling agent, like every other switch finding');
  assert.match(f.explanation, /ARP table of rtr-ot-1 \(10\.20\.0\.1\) at site Plant A \(rack A3\) on Vlan30/);
  assert.equal(f.evidence[0].labels.source, 'device-arp');
  assert.equal(f.evidence[0].labels.deviceId, 1);
  assert.equal(f.evidence[0].labels.sysLocation, 'rack A3');
});

test('ROUTER ARP: a MAC an AGENT at the same site already knows is not new, and the other way round', async () => {
  const repo = makeDeviceArpRepo({ deviceSite: { 1: 3 } });
  await repo.upsertMany(1, [{ ip: '10.30.0.1', mac: '00:80:f4:00:00:01' }], { at: hoursAgo(48) });
  const arp = makeArpEntriesRepo({ agentSite: { 9: 3 } });
  await arp.upsertMany(9, [{ ip: '10.20.0.5', mac: '00:1d:9c:aa:aa:aa' }], { at: hoursAgo(48) });
  const { d, saved } = deviceDetector({ deviceArpRepo: repo, arpEntriesRepo: arp });
  await observeRouter(d, repo, [{ ip: '10.20.0.5', mac: '00:1d:9c:aa:aa:aa' }]);
  assert.equal(saved.length, 0, 'the agent had it');

  // The agent path: a MAC the router at the site already has.
  const agents = { async findById() { return { id: 9, hostname: 'be', location_id: 3 }; } };
  const agentSide = createNewDeviceDetector({
    arpEntriesRepo: arp, deviceArpRepo: repo, agentsRepo: agents, locationsRepo: locationsRepo(),
    findingStore: { async save(f) { saved.push(f); return f; } },
    config: { enabled: true, baselineHours: 24, maxPerHour: 20, severity: 'WARN' }, now: () => NOW,
  });
  const pending = await agentSide.checkArp(9, [{ ip: '10.30.0.1', mac: '00:80:f4:00:00:01' }]);
  assert.equal(pending, null, 'the router had it');
});

test('ROUTER ARP: withDeviceArpDetection wraps the upsert the ingest calls, and a failed check never blocks it', async () => {
  const repo = makeDeviceArpRepo({ deviceSite: { 1: 3 } });
  const wrapped = withDeviceArpDetection(repo, { checkDeviceArp: async () => { throw new Error('x'); }, raiseDeviceArp: async () => [] });
  assert.equal(await wrapped.upsertMany(1, [{ ip: '10.30.0.2', mac: '00:80:f4:00:00:02' }], { at: NOW, device: ROUTER_ROW, agentId: 9 }), 1);
  assert.equal(repo.rows.length, 1);
});

// =============================================================== retention
test('retention: the router ARP table ages on the ARP window', async () => {
  const cuts = [];
  const repo = {
    purgeFlowRollupsBefore: async () => 0, purgeMetricRollupsBefore: async () => 0, purgeAckedFindingsBefore: async () => 0,
    purgeArpEntriesBefore: async (c) => { cuts.push(['arp', c]); return 2; },
    purgeDeviceArpEntriesBefore: async (c) => { cuts.push(['device', c]); return 5; },
  };
  const out = await createPurge({
    repo, config: { rollupRetentionDays: 30, findingRetentionDays: 30, arpRetentionDays: 30 }, now: () => NOW,
  }).purgeExpired();
  assert.equal(out.deviceArpEntries, 5);
  assert.equal(cuts[0][1].getTime(), cuts[1][1].getTime(), 'the same window as arp_entries');
});

// ================================================================ coverage
test('coverage: a neighbour speaking LLDP and CDP is one unmanaged neighbour; a CDP address claims a polled switch', () => {
  const at = new Date();
  const device = { id: 1, host: '10.20.0.1', displayName: 'rtr-ot-1', enabled: true, agentId: 9, lastOkAt: at.toISOString(), sysLocation: 'rack A3', collect: ['lldp'], supported: ['cdp'] };
  const polled = { id: 2, host: '10.14.0.11', displayName: 'sw-dist-9', enabled: true, agentId: 9, lastOkAt: at.toISOString() };
  const ok = (value) => ({ status: 'ok', value });
  const report = buildCoverageReport({
    now: at,
    sources: {
      agents: ok([]), locations: ok([]), snmpDevices: ok([device, polled]), flows: ok([]),
      deviceMacs: ok([]), portMacs: ok([]), agentNeighbours: ok([]), arpSubnets: ok([]),
      discovered: ok({ rows: [], total: 0 }), agentMacs: ok([]), credentials: ok(new Map()),
      deviceNeighbours: ok([
        { deviceId: 1, protocol: 'lldp', localIfName: 'Gi0/0/1', remoteChassisId: 'aa:bb:cc:11:22:33', remoteSysName: 'unknown-sw' },
        { deviceId: 1, protocol: 'cdp', localIfName: 'Gi0/0/1', remoteChassisId: 'unknown-sw.corp', remoteSysName: 'unknown-sw.corp' },
        // CDP names a polled switch by its management address.
        { deviceId: 1, protocol: 'cdp', localIfName: 'Gi0/0/2', remoteChassisId: 'SW-DIST-9.corp', remoteAddress: '10.14.0.11' },
      ]),
    },
  });
  const unmanaged = report.gaps.filter((g) => g.kind === 'unmanagedNeighbour');
  assert.deepEqual(unmanaged.map((g) => g.subject.label), ['unknown-sw']);
  // A device answering CDP is not flagged for lacking LLDP.
  assert.ok(!report.gaps.some((g) => g.kind === 'deviceNoLldp' && g.subject.id === 1));
  // Device gaps carry the room/rack the device names.
  const devGap = report.gaps.find((g) => g.scope === 'device' && g.subject.id === 1);
  assert.equal(devGap.subject.where, 'rack A3');
});

// ================================================================== graph
test('the topology graph joins a CDP neighbour to the polled switch at its management address', () => {
  const g = buildTopologyGraph({
    agents: [],
    devices: [
      { id: 1, host: '10.20.0.1', displayName: 'rtr-ot-1', enabled: true, lastOkAt: new Date().toISOString() },
      { id: 2, host: '10.14.0.11', displayName: 'sw-dist-9', enabled: true, lastOkAt: new Date().toISOString() },
    ],
    deviceNeighbours: [{ deviceId: 1, protocol: 'cdp', localIfName: 'Gi0/0/2', remoteChassisId: 'SW-DIST-9.corp.local', remoteAddress: '10.14.0.11' }],
  });
  assert.equal(g.totals.l2_link, 1);
});
