'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// The SNMP payloads a real agent sends for real switches, through the real
// routes and ingest over the fakes. test/snmpTopologyApi.test.js and
// test/snmpCountersApi.test.js build their bodies by hand, one field at a time;
// these come from blueeye-agent's own pollSnmpTopology / pollSnmpCounters run
// over snmpsim recordings of an HPE ProCurve 6120XG and a Cisco Catalyst 3750
// (test/fixtures/snmp-real/README.md). So a validator that disagrees with what
// the agent actually emits — a field type, a null where the hand-built body had
// a value, a count of rows — fails here rather than on a customer's switch.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeSnmpDevicesRepo,
  makeFdbEntriesRepo,
  makeSnmpNeighborsRepo,
  makeDeviceInterfacesRepo,
  makeCounterSamplesRepo,
} = require('../test-support/fakes');

const DIR = path.join(__dirname, 'fixtures', 'snmp-real');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const DEVICES = ['hpe-procurve-516733-b21', 'cisco-c3750'];

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
const agentsRepo = () => makeAgentsRepo({
  findAll: async () => ([{ id: 9, hostname: 'be-aarhus-01' }]),
  findById: async (id) => (Number(id) === 9 ? { id: 9, hostname: 'be-aarhus-01' } : null),
});

async function seeded() {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  // Device 1, polled by agent 9 — the deviceId the fixtures carry.
  await snmpDevicesRepo.create({
    agentId: 9, host: '192.0.2.50', displayName: 'Recorded switch', community: 'public',
    collect: ['if', 'fdb', 'lldp', 'vlan', 'cdp', 'ifcounters'], counterIntervalSec: 60,
  });
  const repos = {
    snmpDevicesRepo,
    fdbEntriesRepo: makeFdbEntriesRepo(),
    snmpNeighborsRepo: makeSnmpNeighborsRepo(),
    deviceInterfacesRepo: makeDeviceInterfacesRepo(),
    counterSamplesRepo: makeCounterSamplesRepo(),
  };
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), ...repos });
  return { app, ...repos };
}

// Every port the device reported. A name reported twice (the ProCurve's two
// "lo0") is disambiguated by the ingest, so it is two ports, not one.
const portCount = (device) => device.interfaces.length;

const post = (app, route, body) => request(app)
  .post(`/agents/me/${route}`)
  .set('Authorization', 'Bearer agent-tok')
  .send(body);

test('fixtures: both recordings have a topology and a counter payload', () => {
  for (const d of DEVICES) {
    const topo = load(`${d}.topology.json`).devices[0];
    const ctr = load(`${d}.counters.json`).devices[0];
    assert.equal(topo.deviceId, 1);
    assert.ok(topo.interfaces.length > 10 && topo.fdb.length > 10 && topo.neighbours.length > 0, d);
    assert.ok(ctr.interfaces.length > 10, d);
  }
});

for (const d of DEVICES) {
  test(`${d}: the real topology payload validates and stores every interface, FDB row and neighbour`, async () => {
    const { app, snmpDevicesRepo, fdbEntriesRepo, snmpNeighborsRepo, deviceInterfacesRepo } = await seeded();
    const body = load(`${d}.topology.json`);
    const sent = body.devices[0];

    const res = await post(app, 'snmp-topology', body);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.stored, 1);
    assert.equal(res.body.refused, 0);
    assert.equal(res.body.fdbRows, sent.fdb.length);

    assert.equal(fdbEntriesRepo.rows.length, sent.fdb.length);
    for (const row of fdbEntriesRepo.rows) assert.equal(row.device_id, 1);
    // Ports are keyed by NAME (migration 108). The real ProCurve reports ifName
    // "lo0" twice (ifIndex 4170 and 4179); the ingest keeps them as two ports —
    // see the `duplicate ifName` test below — so every reported port lands.
    assert.equal(deviceInterfacesRepo.rows.length, portCount(sent), 'every reported port lands');
    assert.equal(snmpNeighborsRepo.rows.length, new Set(
      sent.neighbours.map((n) => `${n.protocol}|${n.remoteChassisId}|${n.remotePortId ?? ''}`),
    ).size);

    const device = await snmpDevicesRepo.findById(1);
    assert.ok(device.lastOkAt, 'a successful poll is stamped');
    assert.equal(device.lastError, null);
    for (const cap of ['if', 'fdb']) assert.ok(device.supported.includes(cap), cap);
  });

  test(`${d}: the real counter payload, after its topology, stores a sample per port`, async () => {
    const { app, counterSamplesRepo } = await seeded();
    assert.equal((await post(app, 'snmp-topology', load(`${d}.topology.json`))).status, 202);

    const body = load(`${d}.counters.json`);
    // readAt is the capture time; the ingest's previous-sample window ends at
    // NOW, so the cycle is re-stamped to now rather than left to age.
    body.devices[0].readAt = new Date().toISOString();
    const res = await post(app, 'snmp-counters', body);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.stored, 1);
    // One sample per port the device reported counters for (the Catalyst has
    // two inventory ports with no counter row at all).
    const ports = portCount(body.devices[0]);
    assert.equal(res.body.samples, ports, 'every port with counters gets its sample');
    assert.equal(counterSamplesRepo.rows.length, ports);
    // A first cycle is raw counters and no rate — and a counter the device did
    // not report stays null, never becomes 0.
    for (const row of counterSamplesRepo.rows) assert.equal(row.inBps, null);
    const sentNulls = body.devices[0].interfaces.filter((i) => i.fcsErrors == null).length;
    if (sentNulls === body.devices[0].interfaces.length) {
      assert.ok(counterSamplesRepo.rows.every((r) => r.fcsErrors == null), 'absent EtherLike counters stay null');
    } else {
      assert.ok(counterSamplesRepo.rows.some((r) => r.fcsErrors === 0), 'a real zero stays a zero');
    }
  });
}

test('the Catalyst\'s real 48-bit octet counters arrive intact (no 7-byte Counter64 truncation)', async () => {
  // Gi1/0/9's ifHCInOctets in the recording is 257 487 775 630 445 — above
  // 2^47, where net-snmp hands the agent a 7-byte buffer. The agent once read
  // only six of those bytes and reported 1 005 811 623 556.
  const body = load('cisco-c3750.counters.json');
  const port = body.devices[0].interfaces.find((i) => i.ifIndex === 10109);
  assert.equal(port.inOctets, 257487775630445);

  const { app, counterSamplesRepo } = await seeded();
  assert.equal((await post(app, 'snmp-topology', load('cisco-c3750.topology.json'))).status, 202);
  body.devices[0].readAt = new Date().toISOString();
  assert.equal((await post(app, 'snmp-counters', body)).status, 202);
  const stored = counterSamplesRepo.rows.find((r) => r.inOctets === 257487775630445);
  assert.ok(stored, 'stored exactly as sent');
});

test('duplicate ifName on a real switch: two ProCurve "lo0" ports stay two rows, and each keeps its counters', async () => {
  // Recorded fact: the ProCurve 6120XG names ifIndex 4170 AND 4179 "lo0". The
  // port identity is (device, ifName), so the ingest disambiguates within one
  // poll (src/devices/ifNames.js): the lowest ifIndex keeps "lo0", the other
  // becomes "lo0 (ifIndex 4179)" — the same rule on the topology and the
  // counter path, so each counter lands on its own port.
  const sent = load('hpe-procurve-516733-b21.topology.json').devices[0];
  const lo0 = sent.interfaces.filter((i) => i.ifName === 'lo0').map((i) => i.ifIndex).sort((a, b) => a - b);
  assert.deepEqual(lo0, [4170, 4179]);

  const { app, deviceInterfacesRepo, counterSamplesRepo } = await seeded();
  assert.equal((await post(app, 'snmp-topology', { devices: [sent], errors: [] })).status, 202);
  const names = deviceInterfacesRepo.rows.filter((r) => /^lo0( |$)/.test(r.if_name)).map((r) => r.if_name).sort();
  assert.deepEqual(names, ['lo0', 'lo0 (ifIndex 4179)']);

  const counters = load('hpe-procurve-516733-b21.counters.json');
  counters.devices[0].readAt = new Date().toISOString();
  assert.equal((await post(app, 'snmp-counters', counters)).status, 202);
  const lo0Ids = deviceInterfacesRepo.rows.filter((r) => /^lo0( |$)/.test(r.if_name)).map((r) => r.id);
  const sampled = new Set(counterSamplesRepo.rows.filter((r) => lo0Ids.includes(r.interfaceId)).map((r) => r.interfaceId));
  const sentLo0 = counters.devices[0].interfaces.filter((i) => i.ifName === 'lo0').length;
  assert.equal(sampled.size, sentLo0, 'every lo0 counter row reached its own port');
});
