'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Trin 5, wired up: the loop detector over what the server already stores.
//
// Nothing here polls anything. The three facts all come from tables that were
// already being written — the forwarding table (with migration 111's move
// counters), the interface counters, and the device log's spanning-tree events.
// These tests are about the plumbing between them, and about the one thing the
// service adds on top of the pure detector: NOT raising the same loop sixty
// times while somebody looks for the cable.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createL2LoopService } = require('../src/analysis/l2LoopService');
const {
  makeApp, makeFindingStore, makeFdbEntriesRepo, makeCounterSamplesRepo,
  makeDeviceEventsRepo, makeSnmpDevicesRepo, makeAgentsRepo, makeAgentTokensRepo,
  makeDeviceInterfacesRepo,
} = require('../test-support/fakes');

// A switch where six MACs have each bounced ten times between two ports.
function loopingFdb() {
  const repo = makeFdbEntriesRepo();
  const now = new Date();
  for (let i = 0; i < 6; i += 1) {
    repo.rows.push({
      id: i + 1, device_id: 1, mac: `00:1b:44:11:3a:0${i}`, vlan: 20,
      bridge_port: i % 2 === 0 ? 24 : 12,
      prev_bridge_port: i % 2 === 0 ? 12 : 24,
      move_count: 10, last_move_at: now,
      if_index: null, if_name: i % 2 === 0 ? 'Gi1/0/24' : 'Gi1/0/12',
      status: 'learned', port_mac_count: 1, first_seen: now, last_seen: now,
    });
  }
  return repo;
}

function service(over = {}) {
  const findingStore = makeFindingStore();
  const svc = createL2LoopService({
    fdbEntriesRepo: loopingFdb(),
    counterSamplesRepo: null,
    deviceEventsRepo: null,
    findingStore,
    ...over,
  });
  return { svc, findingStore };
}

test('a looping switch raises ONE finding, on the device', async () => {
  const { svc, findingStore } = service();
  const finding = await svc.checkDevice(1, { agentId: 9, deviceName: 'sw-core-1' });

  assert.ok(finding);
  assert.equal(finding.metric, 'l2.loop');
  assert.equal(finding.kind, 'THRESHOLD', 'a fixed rule, not a deviation from a baseline');
  assert.equal(finding.deviceId, 1);
  assert.equal(finding.interfaceId, null, 'a loop is a property of the switch, not of one port');
  assert.equal(finding.hostId, '9', 'the polling agent, so per-agent reads find it');
  assert.equal(findingStore.rows.length, 1);
});

test('the finding carries the two ports to go and look at', async () => {
  const { svc } = service();
  const finding = await svc.checkDevice(1, { agentId: 9, deviceName: 'sw-core-1' });
  const [evidence] = finding.evidence;
  assert.equal(evidence.labels.pairs[0].portA, 12);
  assert.equal(evidence.labels.pairs[0].portB, 24);
  assert.equal(evidence.labels.macs.length, 6);
  assert.match(finding.explanation, /sw-core-1/);
});

test('the same loop is NOT raised again a minute later', async () => {
  // A loop that lasts an hour is one fault, not sixty. Without this the
  // detector raises on every topology cycle for as long as it takes somebody
  // to find the cable.
  const { svc, findingStore } = service();
  assert.ok(await svc.checkDevice(1, { agentId: 9 }));
  assert.equal(await svc.checkDevice(1, { agentId: 9 }), null);
  assert.equal(findingStore.rows.length, 1);
});

test('a quiet switch raises nothing', async () => {
  const { svc } = service({ fdbEntriesRepo: makeFdbEntriesRepo() });
  assert.equal(await svc.checkDevice(1, { agentId: 9 }), null);
});

test('a forwarding table that cannot be read is not a loop', async () => {
  const { svc } = service({
    fdbEntriesRepo: makeFdbEntriesRepo({ movingMacs: async () => { throw new Error('fdb down'); } }),
  });
  assert.equal(await svc.checkDevice(1, { agentId: 9 }), null);
});

test('spanning-tree events raise the score, and their absence never lowers it', async () => {
  // A device that sends no syslog has not said the tree is stable. Its silence
  // must not read as evidence against.
  const deviceEventsRepo = makeDeviceEventsRepo();
  const at = new Date();
  for (let i = 0; i < 4; i += 1) {
    deviceEventsRepo.rows.push({
      id: i + 1, agent_id: 9, device_id: 1, source_ip: '10.14.0.11',
      received_at: at, severity: 5, event_type: 'stp.topology_change',
      summary: 'topology change', transport: 'syslog', occurrences: 1,
    });
  }
  const withEvents = service({ deviceEventsRepo });
  const withNone = service();

  const a = await withEvents.svc.checkDevice(1, { agentId: 9 });
  const b = await withNone.svc.checkDevice(1, { agentId: 9 });
  assert.ok(a.evidence[0].labels.score > b.evidence[0].labels.score);
  assert.equal(a.evidence[0].labels.topoChanges, 4);
});

test('a broadcast baseline is the MEDIAN of the port\'s own history', async () => {
  // A mean would be dragged up by the surge it is supposed to measure against.
  const counterSamplesRepo = makeCounterSamplesRepo();
  const base = Date.now() - 5 * 60_000;
  for (let i = 0; i < 10; i += 1) {
    counterSamplesRepo.rows.push({
      ts: new Date(base + i * 30_000), deviceId: 1, interfaceId: 1,
      inBcastPps: i === 9 ? 900 : 2, discontinuity: null,
    });
  }
  const { svc } = service({ counterSamplesRepo });
  const finding = await svc.checkDevice(1, { agentId: 9 });
  const [b] = finding.evidence[0].labels.broadcast;
  assert.ok(b, 'the surging port is in the evidence');
  assert.equal(b.baselinePps, 2, 'nine samples of 2 and one of 900 — the median is 2');
  assert.equal(b.pps, 900);
});

test('a port with almost no history gets no baseline, and is not evidence', async () => {
  // An absent baseline must never become the strongest possible evidence of a
  // surge, which is exactly what Number(null) === 0 would make it.
  const counterSamplesRepo = makeCounterSamplesRepo();
  counterSamplesRepo.rows.push({
    ts: new Date(), deviceId: 1, interfaceId: 1, inBcastPps: 900, discontinuity: null,
  });
  const { svc } = service({ counterSamplesRepo });
  const finding = await svc.checkDevice(1, { agentId: 9 });
  assert.equal(finding.evidence[0].labels.broadcast.length, 0);
});

test('a counter store that throws does not cost the detection', async () => {
  const { svc } = service({
    counterSamplesRepo: makeCounterSamplesRepo({ latestWithNames: async () => { throw new Error('tsdb down'); } }),
  });
  const finding = await svc.checkDevice(1, { agentId: 9 });
  assert.ok(finding, 'the MAC flapping is still a case on its own');
});

test('a loop finding is grouped like any other finding', async () => {
  // It belongs in the same event as the link flaps and timeouts it is causing.
  const assigned = [];
  const { svc } = service({ eventCaseService: { assignFinding: async (f) => assigned.push(f.id) } });
  await svc.checkDevice(1, { agentId: 9 });
  assert.equal(assigned.length, 1);
});

test('checkDevices skips a device with nothing to say and keeps going', async () => {
  const { svc } = service();
  const found = await svc.checkDevices([1, 2, 1], { agentId: 9 });
  assert.equal(found.length, 1, 'device 2 is quiet, and device 1 is only checked once');
});

// ======================================================= through the ingest
test('a topology cycle that rewrites a forwarding table triggers the check', async () => {
  // Loop detection runs HERE, when the table has just been re-read, because
  // that is the moment a flapping MAC becomes visible. On a timer it would
  // either check a table nothing touched or miss the window entirely.
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11', displayName: 'Core switch' });
  const checked = [];
  const app = makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => ([{ id: 9, hostname: 'be-aarhus-01' }]),
      findById: async () => ({ id: 9, hostname: 'be-aarhus-01' }),
    }),
    agentTokensRepo: makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) }),
    snmpDevicesRepo,
    deviceInterfacesRepo: makeDeviceInterfacesRepo(),
    l2LoopService: { checkDevices: async (ids, opts) => { checked.push({ ids, opts }); return []; } },
  });

  const res = await request(app)
    .post('/agents/me/snmp-topology')
    .set('Authorization', 'Bearer agent-tok')
    .send({
      devices: [{
        deviceId: 1,
        fdb: [{ mac: '00:1b:44:11:3a:b7', vlan: 20, bridgePort: 2, ifIndex: 2, ifName: 'Gi0/2' }],
        supported: ['fdb'],
      }],
    });

  assert.equal(res.status, 202);
  assert.deepEqual(checked[0].ids, [1]);
  assert.equal(checked[0].opts.agentId, 9);
});

test('a detector that throws never costs the sweep that fed it', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11' });
  const app = makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => ([{ id: 9, hostname: 'be-aarhus-01' }]),
      findById: async () => ({ id: 9, hostname: 'be-aarhus-01' }),
    }),
    agentTokensRepo: makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) }),
    snmpDevicesRepo,
    l2LoopService: { checkDevices: async () => { throw new Error('detector exploded'); } },
  });

  const res = await request(app)
    .post('/agents/me/snmp-topology')
    .set('Authorization', 'Bearer agent-tok')
    .send({
      devices: [{
        deviceId: 1,
        fdb: [{ mac: '00:1b:44:11:3a:b7', vlan: 20, bridgePort: 2, ifIndex: 2, ifName: 'Gi0/2' }],
        supported: ['fdb'],
      }],
    });
  assert.equal(res.status, 202);
  assert.equal(res.body.fdbRows, 1, 'the forwarding table still landed');
  assert.equal(res.body.loops, 0);
});

test('a MAC that MOVES is recorded as having moved', async () => {
  // Before migration 111 the upsert overwrote bridge_port in place, so two
  // sweeps of a switch in a loop looked exactly like two sweeps of a quiet one.
  const fdbEntriesRepo = makeFdbEntriesRepo();
  await fdbEntriesRepo.upsertMany(1, [{ mac: '00:1b:44:11:3a:b7', vlan: 20, bridgePort: 12, ifName: 'Gi1/0/12' }]);
  await fdbEntriesRepo.upsertMany(1, [{ mac: '00:1b:44:11:3a:b7', vlan: 20, bridgePort: 24, ifName: 'Gi1/0/24' }]);
  await fdbEntriesRepo.upsertMany(1, [{ mac: '00:1b:44:11:3a:b7', vlan: 20, bridgePort: 12, ifName: 'Gi1/0/12' }]);

  const [row] = await fdbEntriesRepo.listForDevice(1);
  assert.equal(row.moveCount, 2);
  assert.equal(row.prevBridgePort, 24);
  assert.equal(row.bridgePort, 12);
  assert.ok(row.lastMoveAt);
});

test('a MAC that stays put records no move', async () => {
  const fdbEntriesRepo = makeFdbEntriesRepo();
  for (let i = 0; i < 3; i += 1) {
    await fdbEntriesRepo.upsertMany(1, [{ mac: '00:1b:44:11:3a:b7', vlan: 20, bridgePort: 12 }]);
  }
  const [row] = await fdbEntriesRepo.listForDevice(1);
  assert.equal(row.moveCount, 0);
  assert.equal(row.lastMoveAt, null);
});
