'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Trin 1: the ports on a polled switch get an inventory of their own.
//
// The agent has been sending an ifIndex/ifName/ifAlias list on every topology
// poll since stage 02, and the validator has been accepting it. Nothing stored
// it — the join that every per-port measurement needs crossed the wire and was
// thrown away. This file is that gap closed, and it protects the two decisions
// that make the table worth having:
//
//   * THE IDENTITY IS THE NAME, NOT ifIndex. A reboot may renumber; inserting a
//     module into a chassis almost always does. A time series keyed on ifIndex
//     silently mixes two different physical ports.
//   * A RENUMBERING IS REPORTED, not just absorbed. The poll that notices the
//     move is the poll whose counter delta spans two different ports, and the
//     caller has to be told.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeSnmpDevicesRepo,
  makeDeviceInterfacesRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const agentToken = (agentId = 9) => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: agentId }) });

const agentsRepo = () => makeAgentsRepo({
  findAll: async () => ([{ id: 9, hostname: 'be-aarhus-01', display_name: 'Aarhus collector' }]),
  findById: async (id) => (Number(id) === 9 ? { id: 9, hostname: 'be-aarhus-01' } : null),
});

async function seededDevices() {
  const repo = makeSnmpDevicesRepo();
  await repo.create({ agentId: 9, host: '10.14.0.11', displayName: 'Core switch', community: 'public' });
  await repo.create({ agentId: 11, host: '10.22.0.5', displayName: 'Lager switch', community: 'secret' });
  return repo;
}

const IF = (over = {}) => ({
  ifIndex: 10001, ifName: 'GigabitEthernet0/1', ifAlias: 'uplink to core',
  ifDescr: 'GigabitEthernet0/1', ifType: 6, speedMbps: 1000,
  adminStatus: 'up', operStatus: 'up', physAddress: '00:1b:44:11:3a:b7', ...over,
});

const submit = (app, interfaces, deviceId = 1) => request(app)
  .post('/agents/me/snmp-topology')
  .set('Authorization', 'Bearer agent-tok')
  .send({ devices: [{ deviceId, interfaces, supported: ['if'] }] });

const get = (app, path, role = 'viewer') =>
  request(app).get(path).set('Authorization', authHeader(role));

// ===================================================== the list is now stored
test('the interface list the agent already sent is finally stored', async () => {
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(),
    snmpDevicesRepo: await seededDevices(), deviceInterfacesRepo,
  });

  const res = await submit(app, [IF(), IF({ ifIndex: 10002, ifName: 'GigabitEthernet0/2', ifAlias: null })]);
  assert.equal(res.status, 202);
  assert.equal(res.body.interfaceRows, 2);
  assert.equal(deviceInterfacesRepo.rows.length, 2);

  const [first] = deviceInterfacesRepo.rows;
  assert.equal(first.device_id, 1);
  assert.equal(first.if_name, 'GigabitEthernet0/1');
  assert.equal(first.if_index, 10001);
  assert.equal(first.if_alias, 'uplink to core');
  assert.equal(first.if_index_changed_at, null, 'a first sighting is not a move');
});

test('a second poll updates in place rather than adding a row', async () => {
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(),
    snmpDevicesRepo: await seededDevices(), deviceInterfacesRepo,
  });
  await submit(app, [IF()]);
  await submit(app, [IF({ ifAlias: 'uplink to core (rewired)', operStatus: 'down' })]);

  assert.equal(deviceInterfacesRepo.rows.length, 1);
  assert.equal(deviceInterfacesRepo.rows[0].if_alias, 'uplink to core (rewired)');
  assert.equal(deviceInterfacesRepo.rows[0].oper_status, 'down');
});

// ================================================= ifIndex is not the identity
test('a renumbered ifIndex keeps ONE row and is reported back', async () => {
  // A module goes into the chassis and every ifIndex after it shifts. The port
  // is the same port — the name says so — but the counter reading behind the
  // new index belongs to a different one, so the cycle has to be flagged.
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(),
    snmpDevicesRepo: await seededDevices(), deviceInterfacesRepo,
  });
  await submit(app, [IF()]);
  const res = await submit(app, [IF({ ifIndex: 10049 })]);

  assert.equal(deviceInterfacesRepo.rows.length, 1, 'renumbering is not a new port');
  assert.equal(deviceInterfacesRepo.rows[0].if_index, 10049);
  assert.deepEqual(res.body.renumbered, [
    { deviceId: 1, ifName: 'GigabitEthernet0/1', from: 10001, to: 10049 },
  ]);
  assert.ok(deviceInterfacesRepo.rows[0].if_index_changed_at, 'the move is timestamped');
});

test('a port that did not move reports nothing, and keeps the earlier move time', async () => {
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(),
    snmpDevicesRepo: await seededDevices(), deviceInterfacesRepo,
  });
  await submit(app, [IF()]);
  await submit(app, [IF({ ifIndex: 10049 })]);
  const moved = deviceInterfacesRepo.rows[0].if_index_changed_at;

  const res = await submit(app, [IF({ ifIndex: 10049 })]);
  assert.deepEqual(res.body.renumbered, []);
  assert.equal(deviceInterfacesRepo.rows[0].if_index_changed_at, moved,
    'a quiet poll must not erase the last move');
});

test('a port RENAMED is a new row, because the name is the identity', async () => {
  // This is the honest cost of keying on the name: a rename looks like a new
  // port. The alternative — keying on ifIndex — silently merges two different
  // physical ports, which is worse and invisible.
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(),
    snmpDevicesRepo: await seededDevices(), deviceInterfacesRepo,
  });
  await submit(app, [IF()]);
  await submit(app, [IF({ ifName: 'Gi0/1' })]);
  assert.equal(deviceInterfacesRepo.rows.length, 2);
});

test('name_source travels, so a shaky identity is visible', async () => {
  // Not every switch implements ifName. A row built from ifDescr is a weaker
  // identity, and the row says so rather than leaving it to be assumed.
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(),
    snmpDevicesRepo: await seededDevices(), deviceInterfacesRepo,
  });
  await submit(app, [IF({ nameSource: 'ifDescr' })]);
  assert.equal(deviceInterfacesRepo.rows[0].name_source, 'ifDescr');
});

// ===================================================================== reads
test('GET /api/snmp-devices/:id/interfaces lists the ports, viewer+', async () => {
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(),
    snmpDevicesRepo: await seededDevices(), deviceInterfacesRepo,
  });
  await submit(app, [IF({ ifIndex: 10002, ifName: 'Gi0/2' }), IF()]);

  assert.equal((await request(app).get('/api/snmp-devices/1/interfaces')).status, 401);
  const res = await get(app, '/api/snmp-devices/1/interfaces');
  assert.equal(res.status, 200);
  assert.equal(res.body.interfaces.length, 2);
  assert.equal(res.body.interfaces[0].ifIndex, 10001, 'ordered by ifIndex');
  assert.equal(res.body.interfaces[0].ifAlias, 'uplink to core');
});

test('the device page carries its ports beside the forwarding table', async () => {
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(),
    snmpDevicesRepo: await seededDevices(), deviceInterfacesRepo,
  });
  await submit(app, [IF()]);
  const res = await get(app, '/api/snmp-devices/1');
  assert.equal(res.status, 200);
  assert.equal(res.body.interfaces.length, 1);
  assert.equal(res.body.interfaces[0].ifName, 'GigabitEthernet0/1');
});

test('an unknown device is 404, not an empty port list', async () => {
  const app = makeApp({
    agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices(),
    deviceInterfacesRepo: makeDeviceInterfacesRepo(),
  });
  assert.equal((await get(app, '/api/snmp-devices/999/interfaces')).status, 404);
  assert.equal((await get(app, '/api/snmp-devices/abc/interfaces')).status, 400);
});

test('a repository failure is a 500, not a half-drawn port table', async () => {
  const app = makeApp({
    agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices(),
    deviceInterfacesRepo: makeDeviceInterfacesRepo({ listForDevice: throwingAsync('device_interfaces down') }),
  });
  assert.equal((await get(app, '/api/snmp-devices/1/interfaces')).status, 500);
});

test('the device page survives an interface read that throws', async () => {
  // Best-effort, like the forwarding table and the neighbours beside it: the
  // poll state is worth opening the page for on its own.
  const app = makeApp({
    agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices(),
    deviceInterfacesRepo: makeDeviceInterfacesRepo({ listForDevice: throwingAsync('device_interfaces down') }),
  });
  const res = await get(app, '/api/snmp-devices/1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.interfaces, []);
});

// ============================================================== the ownership
test('an agent cannot write the ports of a device it does not poll', async () => {
  // The same rule the forwarding table follows. Without it an agent token could
  // rename another switch's ports.
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9),
    snmpDevicesRepo: await seededDevices(), deviceInterfacesRepo,
  });
  const res = await submit(app, [IF()], 2); // device 2 belongs to agent 11
  assert.equal(res.status, 202);
  assert.equal(res.body.refused, 1);
  assert.equal(deviceInterfacesRepo.rows.length, 0);
});

test('an interface-store failure does not cost the forwarding table', async () => {
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(),
    snmpDevicesRepo: await seededDevices(),
    deviceInterfacesRepo: makeDeviceInterfacesRepo({ upsertMany: throwingAsync('device_interfaces down') }),
  });
  const res = await request(app)
    .post('/agents/me/snmp-topology')
    .set('Authorization', 'Bearer agent-tok')
    .send({
      devices: [{
        deviceId: 1,
        interfaces: [IF()],
        fdb: [{ mac: '00:1b:44:11:3a:b7', vlan: 20, bridgePort: 2, ifIndex: 10002, ifName: 'Gi0/2' }],
        supported: ['if', 'fdb'],
      }],
    });
  assert.equal(res.status, 202);
  assert.equal(res.body.stored, 1);
  assert.equal(res.body.fdbRows, 1, 'the part somebody is waiting for still landed');
  assert.equal(res.body.interfaceRows, 0);
});
