'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// A switch's own syslog and traps belong to the SWITCH (migration 133).
//
// The field run that found this: a collector agent (agent 1) received 110 lines
// from two polled switches, and every one of them was stored against
// device_id = 1 — because the ARP fallback took the agent that had SEEN the
// switch's address in its neighbour table as the device that SENT it. The
// switch's log landed on the collector host's timeline, and no switch had a
// log at all.
//
// What is pinned here, end to end through POST /agents/me/device-events and
// GET /api/device-events:
//   * the sender is resolved against snmp_devices.host FIRST, into
//     snmp_device_id — a different id space from device_id (an agent id);
//   * the agent that received or merely saw the address is never credited;
//   * the device log filters and names per switch, and the agent's own
//     timeline no longer carries the switch's lines.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeArpEntriesRepo,
  makeDeviceEventsRepo,
  makeSnmpDevicesRepo,
  authHeader,
} = require('../test-support/fakes');
const { createDeviceEventIngest, buildDedupKey } = require('../src/devices/deviceEventIngest');

// Agent 1 is the collector host (192.0.2.2). It is the agent that RECEIVES the
// syslog, and its ARP table has seen both switches.
const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 1 }) });
const fleet = () => makeAgentsRepo({
  findAll: async () => ([
    { id: 1, hostname: 'be-collector', monitor_config: { source: 'sflow' }, capabilities: { ips: ['192.0.2.2'] } },
  ]),
  findById: async (id) => (Number(id) === 1 ? { id: 1, hostname: 'be-collector' } : null),
});

async function world() {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  const core = await snmpDevicesRepo.create({ host: '198.51.100.2', displayName: 'Core', agentId: 1 });
  const access = await snmpDevicesRepo.create({ host: '198.51.100.3', agentId: 1 });
  const arpEntriesRepo = makeArpEntriesRepo();
  // The collector has seen both switches — exactly the row that used to be
  // read as "these addresses are agent 1".
  await arpEntriesRepo.upsertMany(1, [
    { ip: '198.51.100.2', mac: '00:1b:2c:00:00:02', interface: 'eth1' },
    { ip: '198.51.100.3', mac: '00:1b:2c:00:00:03', interface: 'eth1' },
    { ip: '198.51.100.9', mac: '00:1b:2c:00:00:09', interface: 'eth1' },
  ]);
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventsRepo, arpEntriesRepo, snmpDevicesRepo });
  return { app, deviceEventsRepo, core, access };
}

const EVENT = (over = {}) => ({
  sourceIp: '198.51.100.2',
  receivedAt: new Date(Date.now() - 60_000).toISOString(),
  deviceTime: null,
  transport: 'syslog',
  facility: 23,
  severity: 3,
  eventType: 'link.down',
  host: 'sw-core',
  tag: '%LINK-3-UPDOWN',
  ifname: 'Gi0/5',
  summary: 'Interface Gi0/5, changed state to down',
  occurrences: 1,
  ...over,
});

const post = (app, events) => request(app)
  .post('/agents/me/device-events')
  .set('Authorization', 'Bearer agent-tok')
  .send({ events });
const get = (app, qs = '') => request(app).get(`/api/device-events${qs}`).set('Authorization', authHeader('viewer'));

test('a switch\'s syslog and traps are stored against the switch, never the collector that saw it', async () => {
  const { app, deviceEventsRepo, core, access } = await world();
  const res = await post(app, [
    EVENT(),
    EVENT({ sourceIp: '198.51.100.3', transport: 'trap', summary: 'linkDown on Gi0/7', ifname: 'Gi0/7' }),
  ]);
  assert.equal(res.status, 202);
  assert.equal(res.body.resolved, 2);
  assert.equal(res.body.unresolved, 0);

  const [a, b] = deviceEventsRepo.rows;
  assert.equal(a.snmp_device_id, core.id);
  assert.equal(b.snmp_device_id, access.id);
  for (const r of [a, b]) {
    assert.equal(r.device_id, null, 'device_id is an AGENT id; the collector merely saw the address');
    assert.equal(r.agent_id, 1, 'still recorded as received by the collector');
  }
});

test('an address the collector saw that is no polled switch stays unresolved', async () => {
  const { app, deviceEventsRepo } = await world();
  const res = await post(app, [EVENT({ sourceIp: '198.51.100.9' })]);
  assert.equal(res.body.unresolved, 1);
  assert.equal(deviceEventsRepo.rows[0].device_id, null);
  assert.equal(deviceEventsRepo.rows[0].snmp_device_id, null);
});

test('the device log filters and names per switch', async () => {
  const { app, core, access } = await world();
  await post(app, [
    EVENT(),
    EVENT({ summary: 'Interface Gi0/6, changed state to down', ifname: 'Gi0/6' }),
    EVENT({ sourceIp: '198.51.100.3', summary: 'on the access switch', ifname: 'Gi0/1' }),
  ]);

  const all = await get(app);
  assert.equal(all.status, 200);
  assert.equal(all.body.events.length, 3);
  const names = all.body.events.map((e) => e.snmpDeviceName).sort();
  assert.deepEqual(names, ['198.51.100.3', 'Core', 'Core'], 'the admin\'s name, else the address');

  const one = await get(app, `?snmpDeviceId=${core.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.events.length, 2);
  assert.ok(one.body.events.every((e) => e.snmpDeviceId === core.id));
  assert.deepEqual(one.body.snmpDevice, { id: core.id, name: 'Core', host: '198.51.100.2' });
  const counted = one.body.counts.reduce((n, c) => n + c.rows, 0);
  assert.equal(counted, 2, 'the chips count the same switch');

  const other = await get(app, `?snmpDeviceId=${access.id}`);
  assert.deepEqual(other.body.events.map((e) => e.summary), ['on the access switch']);
});

test('a switch filter that names no switch is 404; a malformed one is 400', async () => {
  const { app } = await world();
  assert.equal((await get(app, '?snmpDeviceId=999')).status, 404);
  for (const bad of ['0', '-1', 'abc', '1.5']) {
    const res = await get(app, `?snmpDeviceId=${bad}`);
    assert.equal(res.status, 400, bad);
    assert.ok(res.body.details.snmpDeviceId, bad);
  }
});

test('the collector\'s own timeline no longer carries the switch\'s lines', async () => {
  const { app, deviceEventsRepo } = await world();
  await post(app, [EVENT(), EVENT({ sourceIp: '192.0.2.2', summary: 'the collector itself', host: 'be-collector' })]);
  const from = new Date(Date.now() - 3600_000);
  const to = new Date();
  const mine = await deviceEventsRepo.listForDevice(1, { from, to });
  assert.deepEqual(mine.map((e) => e.summary), ['the collector itself'], 'only what the agent host itself said');
});

test('a switch that is also an agent address keeps both ids, in their own columns', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  const sw = await snmpDevicesRepo.create({ host: '10.0.0.2' });
  const deviceEventsRepo = makeDeviceEventsRepo();
  const ingest = createDeviceEventIngest({
    deviceEventsRepo,
    snmpDevicesRepo,
    agentsRepo: makeAgentsRepo({ findAll: async () => [{ id: 7, hostname: 'box', capabilities: { ips: ['10.0.0.2'] } }] }),
  });
  const r = await ingest.ingest(1, [EVENT({ sourceIp: '::ffff:10.0.0.2' })]);
  assert.equal(r.resolved, 1);
  // An IPv4-mapped sender is the IPv4 address it carries; it did not match the
  // agent resolver (which compares strings) but it does match the switch.
  assert.equal(deviceEventsRepo.rows[0].snmp_device_id, sw.id);
  await ingest.ingest(1, [EVENT({ sourceIp: '10.0.0.2', summary: 'second' })]);
  assert.equal(deviceEventsRepo.rows[1].snmp_device_id, sw.id);
  assert.equal(deviceEventsRepo.rows[1].device_id, 7);
});

test('the fold key names the switch, so switch 4 and agent 4 never fold together', () => {
  const e = EVENT({ receivedAt: '2026-09-20T09:41:12.418Z' });
  const asSwitch = buildDedupKey(e, null, undefined, { snmpDeviceId: 4 });
  const asAgent = buildDedupKey(e, 4);
  assert.ok(asSwitch.startsWith('s4|'));
  assert.ok(asAgent.startsWith('d4|'));
  assert.notEqual(asSwitch, asAgent);
});
