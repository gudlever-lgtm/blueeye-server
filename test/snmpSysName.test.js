'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// sysName (migration 133). The agent reads SNMPv2-MIB sysName on every
// topology poll and sends it per device (blueeye-agent PROTOCOL.md,
// snmp-topology) — and the server dropped it at the validator. It is the name
// the switch announces to its LLDP/CDP neighbours, so without it a neighbour
// row naming "sw-dist-1" could not be joined to the switch an admin registered
// as 10.14.0.12 / "Distribution" — the map drew no link, the L2 path had a
// hole, and coverage called a managed switch an unmanaged neighbour.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeSnmpDevicesRepo,
  authHeader,
} = require('../test-support/fakes');
const { validateDeviceTopology } = require('../src/validation/snmpDeviceValidation');
const { buildTopologyGraph } = require('../src/topology/graph');
const { buildSwitchGraph } = require('../src/topology/l2Path');
const { createSearchService } = require('../src/search/searchService');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
const agentsRepo = () => makeAgentsRepo({
  findAll: async () => ([{ id: 9, hostname: 'be-aarhus-01' }]),
  findById: async () => ({ id: 9, hostname: 'be-aarhus-01' }),
});

test('the validator keeps sysName (optional, bounded, strings only)', () => {
  assert.equal(validateDeviceTopology({ deviceId: 1, sysName: '  sw-core-1  ' }).sysName, 'sw-core-1');
  assert.equal(validateDeviceTopology({ deviceId: 1 }).sysName, null, 'an older agent sends none');
  assert.equal(validateDeviceTopology({ deviceId: 1, sysName: 42 }).sysName, null);
  assert.equal(validateDeviceTopology({ deviceId: 1, sysName: 'x'.repeat(400) }).sysName.length, 255);
});

test('sysName from a topology poll is stored, returned, and never erased by an older agent', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11', displayName: 'Core' });
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), snmpDevicesRepo });
  const poll = (body) => request(app)
    .post('/agents/me/snmp-topology')
    .set('Authorization', 'Bearer agent-tok')
    .send({ devices: [{ deviceId: 1, fdb: [], ...body }] });

  assert.equal((await poll({ sysName: 'sw-core-1.plant.local' })).status, 202);
  const detail = await request(app).get('/api/snmp-devices/1').set('Authorization', authHeader('viewer'));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.device.sysName, 'sw-core-1.plant.local');

  await poll({});
  const again = await request(app).get('/api/snmp-devices/1').set('Authorization', authHeader('viewer'));
  assert.equal(again.body.device.sysName, 'sw-core-1.plant.local', 'COALESCE: absent keeps what is stored');
});

const DEVICES = [
  { id: 1, host: '10.14.0.11', displayName: 'Core', sysName: 'sw-core-1', enabled: true },
  { id: 2, host: '10.14.0.12', displayName: 'Distribution', sysName: 'sw-dist-1', enabled: true },
];
// Core's LLDP says it sees "sw-dist-1" on Gi1/0/48 — by NAME (a locally
// assigned chassis id), not by a MAC the server has.
const NEIGHBOURS = [
  { deviceId: 1, protocol: 'lldp', localIfName: 'Gi1/0/48', remoteChassisId: 'sw-dist-1', remoteSysName: 'sw-dist-1', remotePortId: 'Gi0/1' },
];

test('the topology graph joins an LLDP neighbour to the polled switch by its sysName', () => {
  const g = buildTopologyGraph({ agents: [], devices: DEVICES, deviceNeighbours: NEIGHBOURS });
  assert.equal(g.totals.l2_link, 1);
  const without = buildTopologyGraph({ agents: [], devices: DEVICES.map((d) => ({ ...d, sysName: null })), deviceNeighbours: NEIGHBOURS });
  assert.equal(without.totals.l2_link, 0, 'the link exists only because of sysName');
});

test('the L2 path graph joins the same neighbour by sysName, and the port is an uplink, not a foreign neighbour', () => {
  const g = buildSwitchGraph({ devices: DEVICES, neighbours: NEIGHBOURS });
  assert.equal(g.links, 1);
  assert.ok(g.adj.get(1).has(2));
  assert.equal(g.foreign.size, 0);
});

test('universal search finds a switch by the name it calls itself', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ host: '10.14.0.12' });
  await snmpDevicesRepo.recordPoll(1, { ok: true, sysName: 'sw-dist-1' });
  const svc = createSearchService({ agentsRepo: makeAgentsRepo({ findAll: async () => [] }), snmpDevicesRepo });
  const out = await svc.search('sw-dist-1');
  const hit = out.hits.find((h) => h.target === 'snmp-device:1');
  assert.ok(hit, `no device hit: ${JSON.stringify(out.hits.map((h) => h.target))}`);
  assert.equal(hit.confidence, 'exact');
  assert.equal(hit.display_name, 'sw-dist-1 (10.14.0.12)');
});
