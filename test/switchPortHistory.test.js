'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Switch ports get a link-state HISTORY (migration 118), and the switches' own
// LLDP tables get a change log.
//
// Before this, `device_interfaces.oper_status` was overwritten by every poll,
// a link.down trap only reached the Device Log, and a switch's LLDP neighbours
// were never compared from one poll to the next. A core uplink could go down,
// come back and go down again all afternoon without a finding, an alert, an
// event case or a single row in the changes feed.
//
// Everything here goes through the real routes and the real services over the
// fakes: POST /agents/me/snmp-topology, POST /agents/me/device-events, and
// GET /api/changes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeAgentTokensRepo, makeSnmpDevicesRepo, makeDeviceInterfacesRepo,
  makeInterfaceStatesRepo, makeSnmpNeighborsRepo, makeTopologyChangesRepo, makeFindingStore,
  makeDispatcher, makeDeviceEventsRepo, makeFdbEntriesRepo, authHeader,
} = require('../test-support/fakes');
const {
  createSwitchPortStateService, portState, FLAP_FINDING_TRANSITIONS,
} = require('../src/devices/switchPortStateService');
const { metricFamily } = require('../src/changes/indications');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
const agentsRepo = () => makeAgentsRepo({
  findAll: async () => ([{ id: 9, hostname: 'be-aarhus-01', display_name: 'Aarhus agent', last_seen: new Date().toISOString(), capabilities: {} }]),
  findById: async () => ({ id: 9, hostname: 'be-aarhus-01' }),
});

const port = (ifName, ifIndex, operStatus = 'up', adminStatus = 'up') => ({
  ifName, ifIndex, operStatus, adminStatus, speedMbps: 1000,
});
const NEIGHBOUR = {
  localIfName: 'Gi1/0/24', localIfIndex: 24, remoteChassisId: '00:11:22:33:44:55',
  remotePortId: 'Gi0/1', remoteSysName: 'sw-acc-2',
};

async function harness(over = {}) {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11', displayName: 'sw-core-1', intervalSec: 60 });
  const deps = {
    snmpDevicesRepo,
    deviceInterfacesRepo: makeDeviceInterfacesRepo(),
    interfaceStatesRepo: makeInterfaceStatesRepo(),
    snmpNeighborsRepo: makeSnmpNeighborsRepo(),
    topologyChangesRepo: makeTopologyChangesRepo(),
    findingStore: makeFindingStore(),
    dispatcher: makeDispatcher(),
    deviceEventsRepo: makeDeviceEventsRepo(),
    fdbEntriesRepo: makeFdbEntriesRepo(),
    ...over,
  };
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), ...deps });
  const poll = (device) => request(app)
    .post('/agents/me/snmp-topology')
    .set('Authorization', 'Bearer agent-tok')
    .send({ devices: [{ deviceId: 1, fdb: [], neighbours: [], ...device }] });
  const events = (list) => request(app)
    .post('/agents/me/device-events')
    .set('Authorization', 'Bearer agent-tok')
    .send({ events: list });
  return { app, poll, events, ...deps };
}

const linkEvent = (over = {}) => ({
  sourceIp: '10.14.0.11',
  receivedAt: new Date().toISOString(),
  deviceTime: null,
  transport: 'trap',
  facility: null,
  severity: 2,
  eventType: 'link.down',
  tag: '1.3.6.1.6.3.1.1.5.3',
  ifname: 'Gi1/0/2',
  summary: 'linkDown on Gi1/0/2',
  raw: 'snmpTrapOID=1.3.6.1.6.3.1.1.5.3',
  occurrences: 1,
  ...over,
});

// ================================================================ the poll path
test('the first poll of a switch is a baseline, not a list of changes', async () => {
  const h = await harness();
  const res = await h.poll({ interfaces: [port('Gi1/0/1', 1), port('Gi1/0/2', 2, 'down')] });
  assert.equal(res.status, 202);
  assert.equal(h.interfaceStatesRepo.transitions.length, 0, 'a port first seen down is not a change');
});

test('a port that goes down between two polls is RECORDED, naming the switch and the port', async () => {
  const h = await harness();
  await h.poll({ interfaces: [port('Gi1/0/1', 1), port('Gi1/0/2', 2)] });
  const res = await h.poll({ interfaces: [port('Gi1/0/1', 1), port('Gi1/0/2', 2, 'down')] });
  assert.equal(res.body.portTransitions, 1);

  const [row] = h.interfaceStatesRepo.transitions;
  assert.equal(row.device_id, 1);
  assert.equal(row.iface, 'Gi1/0/2');
  assert.ok(row.interface_id, 'the port row id rides along');
  assert.equal(row.agent_id, 9, 'the agent that observed it, so per-agent reads still find it');
  assert.equal(row.source, 'poll');
  assert.equal(row.from_status, 'ok');
  assert.equal(row.to_status, 'down');
  assert.match(row.summary, /sw-core-1 Gi1\/0\/2 link went down/);
  // An access port going down is what happens when somebody switches a PC off.
  assert.equal(row.severity, 'INFO');
  assert.equal(h.findingStore.rows.length, 0, 'no finding for an access port going down once');
});

test('an UPLINK going down is a CRIT finding that is alerted and names the switch, the port and the neighbour', async () => {
  const h = await harness();
  await h.poll({ interfaces: [port('Gi1/0/24', 24)], neighbours: [NEIGHBOUR] });
  // The neighbour is gone from this poll's LLDP table along with the link —
  // which is why "was it an uplink" is read from the PREVIOUS table.
  await h.poll({ interfaces: [port('Gi1/0/24', 24, 'down')], neighbours: [] });

  const [row] = h.interfaceStatesRepo.transitions;
  assert.equal(row.severity, 'CRIT');
  assert.match(row.summary, /uplink to sw-acc-2/);

  assert.equal(h.findingStore.rows.length, 1);
  const f = h.findingStore.rows[0];
  assert.equal(f.metric, `if.${row.interface_id}.link.down`);
  assert.equal(f.severity, 'CRIT');
  assert.equal(f.device_id ?? f.deviceId, 1);
  assert.match(f.explanation, /Gi1\/0\/24/);
  assert.match(f.explanation, /sw-core-1/);
  assert.match(f.explanation, /sw-acc-2/);
  assert.equal(h.dispatcher.calls.length, 1, 'it reaches alerting');
  assert.equal(metricFamily(f.metric), 'interface');
});

test('a port bouncing between polls collapses onto ONE row and raises a flapping finding', async () => {
  const h = await harness();
  await h.poll({ interfaces: [port('Gi1/0/2', 2)] });
  const states = ['down', 'up', 'down', 'up'];
  for (const s of states) await h.poll({ interfaces: [port('Gi1/0/2', 2, s)] });

  assert.equal(h.interfaceStatesRepo.transitions.length, 1, 'one row, however many bounces');
  const row = h.interfaceStatesRepo.transitions[0];
  assert.equal(row.flapping, 1);
  assert.equal(row.flap_count, states.length);
  assert.match(row.summary, /flapping 4×/);

  const flaps = h.findingStore.rows.filter((f) => /link\.flapping$/.test(f.metric));
  assert.equal(flaps.length, 1, 'one flapping finding — the refractory period holds the rest');
  assert.equal(flaps[0].severity, 'WARN', 'an access port flapping is a fault, but not an outage');
  assert.match(flaps[0].explanation, /Gi1\/0\/2 on sw-core-1/);
  assert.ok(FLAP_FINDING_TRANSITIONS <= states.length);
});

test('a port somebody SHUT DOWN is a change, never a fault', async () => {
  const h = await harness();
  await h.poll({ interfaces: [port('Gi1/0/24', 24)], neighbours: [NEIGHBOUR] });
  await h.poll({ interfaces: [port('Gi1/0/24', 24, 'down', 'down')], neighbours: [NEIGHBOUR] });
  const [row] = h.interfaceStatesRepo.transitions;
  assert.equal(row.to_status, 'disabled');
  assert.equal(row.severity, 'INFO');
  assert.equal(h.findingStore.rows.length, 0, 'not even on an uplink');
});

test('a status that says nothing about the link is not a change', () => {
  assert.equal(portState({ operStatus: 'dormant' }), null);
  assert.equal(portState({ operStatus: 'notPresent' }), null);
  assert.equal(portState({ operStatus: 'lowerLayerDown' }), 'down');
  assert.equal(portState({ adminStatus: 'down', operStatus: 'up' }), 'disabled');
});

test('switch-port transitions appear in GET /api/changes, named by the switch — not "on <agent>"', async () => {
  const h = await harness();
  await h.poll({ interfaces: [port('Gi1/0/24', 24)], neighbours: [NEIGHBOUR] });
  await h.poll({ interfaces: [port('Gi1/0/24', 24, 'down')] });

  const res = await request(h.app).get('/api/changes?window=6h').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const row = res.body.events.find((e) => e.kind === 'interface_state');
  assert.ok(row, 'the switch port is in the feed');
  assert.equal(row.severity, 'CRIT');
  assert.match(row.summary, /^sw-core-1 Gi1\/0\/24 link went down/);
  assert.doesNotMatch(row.summary, /on Aarhus agent/);
});

test('a port-history failure never costs the topology cycle', async () => {
  const h = await harness({
    interfaceStatesRepo: makeInterfaceStatesRepo({ insertTransition: async () => { throw new Error('db down'); } }),
  });
  await h.poll({ interfaces: [port('Gi1/0/2', 2)] });
  const res = await h.poll({ interfaces: [port('Gi1/0/2', 2, 'down')] });
  assert.equal(res.status, 202);
  assert.equal(res.body.stored, 1);
});

// ============================================================ the event path
test('a link.down TRAP from a polled switch is tied to its port and recorded', async () => {
  const h = await harness();
  await h.poll({ interfaces: [port('Gi1/0/2', 2)] });

  const res = await h.events([linkEvent()]);
  assert.equal(res.status, 202);
  const [row] = h.interfaceStatesRepo.transitions;
  assert.ok(row, 'the trap reached the port history');
  assert.equal(row.source, 'trap');
  assert.equal(row.device_id, 1);
  assert.equal(row.to_status, 'down');

  // The port row is the latest known state, so the next poll saying the same
  // thing is not a second change.
  const portRow = h.deviceInterfacesRepo.rows.find((r) => r.if_name === 'Gi1/0/2');
  assert.equal(portRow.oper_status, 'down');
  await h.poll({ interfaces: [port('Gi1/0/2', 2, 'down')] });
  assert.equal(h.interfaceStatesRepo.transitions.length, 1, 'the poll did not announce it again');
});

test('a syslog line naming the port the LONG way (ifDescr) is still tied to it', async () => {
  const h = await harness();
  await h.poll({ interfaces: [{ ...port('Gi1/0/2', 2), ifDescr: 'GigabitEthernet1/0/2' }] });
  await h.events([linkEvent({ transport: 'syslog', ifname: 'GigabitEthernet1/0/2', tag: 'LINK-3-UPDOWN' })]);
  assert.equal(h.interfaceStatesRepo.transitions.length, 1);
  assert.equal(h.interfaceStatesRepo.transitions[0].source, 'syslog');
});

test('the trap and the syslog line for ONE event record it once', async () => {
  const h = await harness();
  await h.poll({ interfaces: [port('Gi1/0/2', 2)] });
  await h.events([linkEvent(), linkEvent({ transport: 'syslog', tag: 'LINK-3-UPDOWN' })]);
  assert.equal(h.interfaceStatesRepo.transitions.length, 1);
});

test('an event from a sender the server does not poll, or naming no known port, stays in the Device Log only', async () => {
  const h = await harness();
  await h.poll({ interfaces: [port('Gi1/0/2', 2)] });
  await h.events([linkEvent({ sourceIp: '10.99.0.1' }), linkEvent({ ifname: 'Gi9/9/9' })]);
  assert.equal(h.interfaceStatesRepo.transitions.length, 0);
  assert.equal(h.deviceEventsRepo.rows.length, 2, 'both events are still stored');
});

test('a port flapping by traps raises a flapping finding, and it is alerted', async () => {
  const h = await harness();
  await h.poll({ interfaces: [port('Gi1/0/24', 24)], neighbours: [NEIGHBOUR] });
  const t0 = Date.now() - 60_000;
  await h.events([
    linkEvent({ ifname: 'Gi1/0/24', receivedAt: new Date(t0).toISOString(), summary: 'down 1' }),
    linkEvent({ ifname: 'Gi1/0/24', eventType: 'link.up', receivedAt: new Date(t0 + 10_000).toISOString(), summary: 'up 1' }),
    linkEvent({ ifname: 'Gi1/0/24', receivedAt: new Date(t0 + 20_000).toISOString(), summary: 'down 2' }),
  ]);
  assert.equal(h.interfaceStatesRepo.transitions.length, 1);
  const metrics = h.findingStore.rows.map((f) => f.metric);
  assert.ok(metrics.some((m) => /link\.down$/.test(m)), 'the uplink going down, first');
  const flap = h.findingStore.rows.find((f) => /link\.flapping$/.test(f.metric));
  assert.ok(flap, 'then the flapping');
  assert.equal(flap.severity, 'CRIT', 'an uplink flapping cuts everything behind it off, again and again');
  assert.equal(h.dispatcher.calls.length, 2);
});

test('the service alone: a finding sink that throws never costs the transition', async () => {
  const interfaceStatesRepo = makeInterfaceStatesRepo();
  const svc = createSwitchPortStateService({
    interfaceStatesRepo,
    findingSink: { emit: async () => { throw new Error('store down'); } },
  });
  const out = await svc.recordPollChanges({
    agentId: 9,
    device: { id: 1, displayName: 'sw-core-1' },
    changes: [{ interfaceId: 5, ifName: 'Gi1/0/24', from: { adminStatus: 'up', operStatus: 'up' }, to: { adminStatus: 'up', operStatus: 'down' } }],
    neighbours: [NEIGHBOUR],
  });
  assert.equal(out.transitions, 1);
  assert.equal(out.findings.length, 0);
});

// ====================================================== switch-seen LLDP diff
test('the first LLDP snapshot of a switch is a BASELINE, not forty "neighbour added" rows', async () => {
  const h = await harness();
  const many = Array.from({ length: 5 }, (_, i) => ({ ...NEIGHBOUR, localIfName: `Gi1/0/${i + 1}`, remoteChassisId: `aa:bb:cc:00:00:0${i}` }));
  await h.poll({ neighbours: many });
  assert.equal(h.topologyChangesRepo.rows.length, 0);
});

test('a neighbour that appears, disappears or moves port is written to topology_changes for that switch', async () => {
  const h = await harness();
  const a = { ...NEIGHBOUR, localIfName: 'Gi1/0/1', remoteChassisId: 'aa:aa:aa:aa:aa:aa', remoteSysName: 'ap-1' };
  const b = { ...NEIGHBOUR, localIfName: 'Gi1/0/2', remoteChassisId: 'bb:bb:bb:bb:bb:bb', remoteSysName: 'ap-2' };
  const c = { ...NEIGHBOUR, localIfName: 'Gi1/0/3', remoteChassisId: 'cc:cc:cc:cc:cc:cc', remoteSysName: 'phone-3' };
  await h.poll({ neighbours: [a, b] });
  const res = await h.poll({ neighbours: [{ ...a, localIfName: 'Gi1/0/9' }, c] });
  assert.equal(res.body.neighbourChanges, 3);

  const byType = Object.fromEntries(h.topologyChangesRepo.rows.map((r) => [r.change_type, r]));
  assert.ok(byType.port_moved && byType.neighbour_added && byType.neighbour_removed, JSON.stringify(Object.keys(byType)));
  for (const r of h.topologyChangesRepo.rows) {
    assert.equal(r.device_id, 1, 'the switch it was seen on');
    assert.equal(r.agent_id, 9, 'and the agent that polled it');
    assert.match(r.summary, /^sw-core-1: /);
  }
  assert.match(byType.port_moved.summary, /ap-1/);
  assert.match(byType.neighbour_removed.summary, /ap-2/);

  const feed = await request(h.app).get('/api/changes?window=6h').set('Authorization', authHeader('viewer'));
  assert.equal(feed.status, 200);
  assert.ok(feed.body.events.some((e) => e.kind === 'topology' && /sw-core-1/.test(e.summary)),
    'switch-seen neighbour changes reach the changes feed');
});

test('an EMPTY LLDP table is not "every neighbour left"', async () => {
  const h = await harness();
  await h.poll({ neighbours: [NEIGHBOUR] });
  await h.poll({ neighbours: [] });
  assert.equal(h.topologyChangesRepo.rows.length, 0);
});

test('a neighbour that left is not announced as leaving again on the next poll', async () => {
  const h = await harness();
  const a = { ...NEIGHBOUR, localIfName: 'Gi1/0/1', remoteChassisId: 'aa:aa:aa:aa:aa:aa' };
  const b = { ...NEIGHBOUR, localIfName: 'Gi1/0/2', remoteChassisId: 'bb:bb:bb:bb:bb:bb' };
  await h.poll({ neighbours: [a, b] });
  await new Promise((r) => setTimeout(r, 1100)); // a later sweep, a later last_seen
  await h.poll({ neighbours: [a] });
  await new Promise((r) => setTimeout(r, 1100));
  await h.poll({ neighbours: [a] });
  assert.equal(h.topologyChangesRepo.rows.filter((r) => r.change_type === 'neighbour_removed').length, 1);
});
