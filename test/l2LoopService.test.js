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

const { createL2LoopService, MAX_BASELINE_PORTS, MIN_SWEEPS_PER_WINDOW } = require('../src/analysis/l2LoopService');
const {
  makeApp, makeFindingStore, makeFdbEntriesRepo, makeCounterSamplesRepo,
  makeDeviceEventsRepo, makeSnmpDevicesRepo, makeAgentsRepo, makeAgentTokensRepo,
  makeDeviceInterfacesRepo,
} = require('../test-support/fakes');

// A switch where six MACs have each bounced between two ports, sweep after
// sweep. Built THROUGH the repository's own upsert (not by seeding move_count),
// because since migration 117 the detector counts the MOVES recorded inside its
// window — a row whose all-time move_count says 10 but whose moves happened a
// month ago is exactly the case the old reading got wrong.
async function loopingFdb({ sweeps = 10, stepMs = 30_000, endAt = Date.now(), repo = makeFdbEntriesRepo() } = {}) {
  for (let k = 0; k < sweeps; k += 1) {
    const at = new Date(endAt - (sweeps - 1 - k) * stepMs);
    const entries = [];
    for (let i = 0; i < 6; i += 1) {
      // Even MACs end on 24, odd on 12, and every sweep sees each on the other port.
      const onA = (i + k) % 2 === 0;
      entries.push({
        mac: `00:1b:44:11:3a:0${i}`, vlan: 20,
        bridgePort: onA ? 12 : 24, ifName: onA ? 'Gi1/0/12' : 'Gi1/0/24',
      });
    }
    await repo.upsertMany(1, entries, { at });
  }
  return repo;
}

// The switch these tests poll, as snmp_devices has it. Its HOST is how its own
// syslog/trap events are found, and its interval sets the window.
const DEVICE = { id: 1, host: '10.14.0.11', displayName: 'sw-core-1', intervalSec: 60 };

async function service(over = {}) {
  const findingStore = makeFindingStore();
  const svc = createL2LoopService({
    fdbEntriesRepo: over.fdbEntriesRepo || await loopingFdb(),
    counterSamplesRepo: null,
    deviceEventsRepo: null,
    findingStore,
    ...over,
  });
  return { svc, findingStore };
}

test('a looping switch raises ONE finding, on the device', async () => {
  const { svc, findingStore } = await service();
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
  const { svc } = await service();
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
  const { svc, findingStore } = await service();
  assert.ok(await svc.checkDevice(1, { agentId: 9 }));
  assert.equal(await svc.checkDevice(1, { agentId: 9 }), null);
  assert.equal(findingStore.rows.length, 1);
});

test('a quiet switch raises nothing', async () => {
  const { svc } = await service({ fdbEntriesRepo: makeFdbEntriesRepo() });
  assert.equal(await svc.checkDevice(1, { agentId: 9 }), null);
});

test('a forwarding table that cannot be read is not a loop', async () => {
  const { svc } = await service({
    fdbEntriesRepo: makeFdbEntriesRepo({ movingMacs: async () => { throw new Error('fdb down'); } }),
  });
  assert.equal(await svc.checkDevice(1, { agentId: 9 }), null);
});

test('spanning-tree events raise the score, and their absence never lowers it', async () => {
  // A device that sends no syslog has not said the tree is stable. Its silence
  // must not read as evidence against.
  //
  // The events are seeded the way the ingest actually stores them: `device_id`
  // is whatever AGENT the hostResolver matched (here none, NULL), and the switch
  // is identifiable only by the address it sent from — its polled host. This
  // test used to seed device_id: 1, the snmp_devices id, which is a value the
  // ingest never writes, and so it passed against a lookup that found nothing
  // in production.
  const deviceEventsRepo = makeDeviceEventsRepo();
  const at = new Date();
  for (let i = 0; i < 4; i += 1) {
    await deviceEventsRepo.createMany(9, [{
      deviceId: null, sourceIp: DEVICE.host, receivedAt: at.toISOString(), severity: 5,
      eventType: 'stp.topology_change', summary: `topology change ${i}`, transport: 'syslog',
    }]);
  }
  const withEvents = await service({ deviceEventsRepo });
  const withNone = await service();

  const a = await withEvents.svc.checkDevice(1, { agentId: 9, device: DEVICE });
  const b = await withNone.svc.checkDevice(1, { agentId: 9, device: DEVICE });
  assert.ok(a.evidence[0].labels.score > b.evidence[0].labels.score);
  assert.equal(a.evidence[0].labels.topoChanges, 4);
});

test('STP events are matched by the SWITCH\'S ADDRESS, never by an agent id that happens to share its number', async () => {
  // device_events.device_id holds an AGENT id. Agent 1's own events must not be
  // read as switch 1 reconverging.
  const deviceEventsRepo = makeDeviceEventsRepo();
  const at = new Date().toISOString();
  for (let i = 0; i < 4; i += 1) {
    await deviceEventsRepo.createMany(9, [{
      deviceId: 1, sourceIp: '192.0.2.50', receivedAt: at, severity: 5,
      eventType: 'stp.topology_change', summary: `someone else's tree ${i}`, transport: 'syslog',
    }]);
  }
  const { svc } = await service({ deviceEventsRepo });
  const f = await svc.checkDevice(1, { agentId: 9, device: DEVICE });
  assert.equal(f.evidence[0].labels.topoChanges, 0);
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
  const { svc } = await service({ counterSamplesRepo });
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
  const { svc } = await service({ counterSamplesRepo });
  const finding = await svc.checkDevice(1, { agentId: 9 });
  assert.equal(finding.evidence[0].labels.broadcast.length, 0);
});

test('a counter store that throws does not cost the detection', async () => {
  const { svc } = await service({
    counterSamplesRepo: makeCounterSamplesRepo({ latestWithNames: async () => { throw new Error('tsdb down'); } }),
  });
  const finding = await svc.checkDevice(1, { agentId: 9 });
  assert.ok(finding, 'the MAC flapping is still a case on its own');
});

test('a loop finding is grouped like any other finding', async () => {
  // It belongs in the same event as the link flaps and timeouts it is causing.
  const assigned = [];
  const { svc } = await service({ eventCaseService: { assignFinding: async (f) => assigned.push(f.id) } });
  await svc.checkDevice(1, { agentId: 9 });
  assert.equal(assigned.length, 1);
});

test('checkDevices skips a device with nothing to say and keeps going', async () => {
  const { svc } = await service();
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

test('the baseline reads are BOUNDED, and go to the busiest ports', async () => {
  // One query per port, and a chassis has hundreds. The check only runs on a
  // device whose MACs are actually moving, which already keeps it rare — but
  // rare and unbounded is still unbounded, and this is the read that would
  // fan out on the biggest switch in the building.
  const asked = [];
  const ports = [];
  for (let i = 1; i <= 300; i += 1) {
    // Ascending rates, so the LAST ports are the busiest — if the cap took the
    // first N instead of the highest N, this test would see port 1.
    ports.push({ interfaceId: i, ifName: `Gi1/0/${i}`, inBcastPps: i });
  }
  const counterSamplesRepo = {
    latestWithNames: async () => ports,
    series: async (interfaceId) => { asked.push(interfaceId); return { samples: [] }; },
  };

  const { svc } = await service({ counterSamplesRepo });
  await svc.checkDevice(1, { agentId: 9 });

  assert.equal(asked.length, MAX_BASELINE_PORTS, 'the baseline read fanned out past the cap');
  assert.ok(asked.includes(300), 'the busiest port must be one of the ones looked at');
  assert.ok(!asked.includes(1), 'the quietest port is not where a broadcast surge is');
});

// ============================================== moves INSIDE the window (117)
test('an all-time move count is NOT moves in the window', async () => {
  // THE BUG: move_count is monotonic and reset by nothing, and it used to be
  // read as movesInWindow. Six MACs that each moved ten times LAST MONTH looked
  // exactly like six MACs flapping ten times in the last ten minutes.
  const fdbEntriesRepo = await loopingFdb({ endAt: Date.now() - 30 * 24 * 3600 * 1000 });
  assert.ok(fdbEntriesRepo.rows.every((r) => r.move_count >= 9), 'the all-time count is still there');
  const { svc } = await service({ fdbEntriesRepo });
  assert.equal(await svc.checkDevice(1, { agentId: 9, device: DEVICE }), null);
});

test('the moves counted are the ones inside the window, and the finding says how many', async () => {
  const { svc } = await service();
  const f = await svc.checkDevice(1, { agentId: 9, device: DEVICE });
  // Ten sweeps, each seeing every MAC on the other port: nine moves apiece.
  assert.ok(f.evidence[0].labels.macs.every((m) => m.moves === 9), JSON.stringify(f.evidence[0].labels.macs));
});

test('the window stretches to cover enough SWEEPS of a slowly-polled switch', async () => {
  // A sweep sees at most one move per MAC. At the default five-minute topology
  // interval a ten-minute window holds two sweeps, and a MAC could never reach
  // MIN_MOVES_PER_MAC inside it — the loop detector could not fire at all.
  const fdbEntriesRepo = await loopingFdb({ sweeps: 8, stepMs: 300_000 });
  const slow = { ...DEVICE, intervalSec: 300 };
  const { svc } = await service({ fdbEntriesRepo });
  const f = await svc.checkDevice(1, { agentId: 9, device: slow });
  assert.ok(f, 'eight five-minute sweeps of flapping MACs is a loop');
  assert.equal(f.evidence[0].labels.windowMinutes, MIN_SWEEPS_PER_WINDOW * 5);

  // The same history judged over the bare ten-minute floor would not be.
  const fast = await service({ fdbEntriesRepo: await loopingFdb({ sweeps: 8, stepMs: 300_000 }) });
  assert.equal(await fast.svc.checkDevice(1, { agentId: 9, device: { ...DEVICE, intervalSec: 60 } }), null);
});

// ====================================================== a storm on its own
function stormCounters({ sustained = true, pps = 900 } = {}) {
  // An hour of a quiet port (2 broadcasts/s), then the storm: the last two
  // samples, or only the very last one.
  const repo = makeCounterSamplesRepo();
  const now = Date.now();
  for (let i = 0; i < 30; i += 1) {
    const recent = sustained ? i >= 28 : i === 29;
    repo.rows.push({
      ts: new Date(now - (29 - i) * 60_000), deviceId: 1, interfaceId: 7, ifName: 'Gi1/0/7',
      inBcastPps: recent ? pps : 2, discontinuity: null,
    });
  }
  return repo;
}

test('a SUSTAINED broadcast storm on one port, with no MAC moving, is a suspected loop behind that port', async () => {
  // A loop inside an unmanaged desk switch never makes a MAC flap on the
  // managed one: every frame from down there arrives on the same port. What
  // this switch sees is broadcast pouring in on that port and not stopping.
  const { svc, findingStore } = await service({
    fdbEntriesRepo: makeFdbEntriesRepo(), counterSamplesRepo: stormCounters(),
  });
  const f = await svc.checkDevice(1, { agentId: 9, device: DEVICE, deviceName: 'sw-core-1' });
  assert.ok(f, 'a sustained storm is raised');
  assert.equal(f.severity, 'WARN', 'never CRIT: the MAC-flap corroboration is exactly what is missing');
  assert.equal(f.evidence[0].labels.basis, 'broadcast');
  assert.match(f.explanation, /Gi1\/0\/7/);
  assert.match(f.explanation, /suspicion/i);
  assert.equal(findingStore.rows.length, 1);
});

test('a single broadcast burst, or a quiet port, is not raised', async () => {
  const burst = await service({
    fdbEntriesRepo: makeFdbEntriesRepo(), counterSamplesRepo: stormCounters({ sustained: false }),
  });
  assert.equal(await burst.svc.checkDevice(1, { agentId: 9, device: DEVICE }), null);

  // Ten times its baseline, sustained — but twenty broadcasts a second is not a
  // storm, it is a port that got chattier.
  const mild = await service({
    fdbEntriesRepo: makeFdbEntriesRepo(), counterSamplesRepo: stormCounters({ pps: 20 }),
  });
  assert.equal(await mild.svc.checkDevice(1, { agentId: 9, device: DEVICE }), null);
});

// ============================================================ alerting (7d)
test('a loop finding is ALERTED, not only stored', async () => {
  // The service used to store, publish and group a loop and never hand it to
  // the dispatcher — a loop on the core switch opened an event case and paged
  // nobody.
  const dispatched = [];
  const { svc } = await service({
    dispatcher: { dispatch: async (f) => { dispatched.push(f.metric); return { dispatched: true }; } },
    alertingEnabled: () => true,
  });
  await svc.checkDevice(1, { agentId: 9, device: DEVICE });
  assert.deepEqual(dispatched, ['l2.loop']);
});

test('alerting stays behind its flag', async () => {
  const dispatched = [];
  const { svc } = await service({
    dispatcher: { dispatch: async (f) => { dispatched.push(f.metric); } },
    alertingEnabled: () => false,
  });
  assert.ok(await svc.checkDevice(1, { agentId: 9, device: DEVICE }));
  assert.deepEqual(dispatched, []);
});

test('a finding that could not be stored is not raised, and does not start the refractory period', async () => {
  let fail = true;
  const findingStore = makeFindingStore();
  const save = findingStore.save.bind(findingStore);
  findingStore.save = async (f) => { if (fail) throw new Error('db down'); return save(f); };
  const { svc } = await service({ findingStore });
  assert.equal(await svc.checkDevice(1, { agentId: 9, device: DEVICE }), null);
  fail = false;
  assert.ok(await svc.checkDevice(1, { agentId: 9, device: DEVICE }), 'the next cycle can raise it');
});

test('through the topology ingest: sweeps that bounce MACs raise a loop from the RECORDED moves', async () => {
  // End to end: the forwarding tables arrive over POST /agents/me/snmp-topology,
  // the repository records each move, and the detector counts them.
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11', displayName: 'Core switch', intervalSec: 60 });
  const fdbEntriesRepo = makeFdbEntriesRepo();
  const findingStore = makeFindingStore();
  const l2LoopService = createL2LoopService({ fdbEntriesRepo, snmpDevicesRepo, findingStore });
  const app = makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => ([{ id: 9, hostname: 'be-aarhus-01' }]),
      findById: async () => ({ id: 9, hostname: 'be-aarhus-01' }),
    }),
    agentTokensRepo: makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) }),
    snmpDevicesRepo, fdbEntriesRepo, l2LoopService, findingStore,
  });

  const loops = [];
  for (let k = 0; k < 6; k += 1) {
    const fdb = [];
    for (let i = 0; i < 4; i += 1) {
      const onA = (i + k) % 2 === 0;
      fdb.push({ mac: `00:1b:44:11:3a:1${i}`, vlan: 20, bridgePort: onA ? 12 : 24, ifIndex: onA ? 12 : 24, ifName: onA ? 'Gi1/0/12' : 'Gi1/0/24' });
    }
    const res = await request(app)
      .post('/agents/me/snmp-topology')
      .set('Authorization', 'Bearer agent-tok')
      .send({ devices: [{ deviceId: 1, fdb, supported: ['fdb'] }] });
    assert.equal(res.status, 202);
    loops.push(res.body.loops);
  }
  // Sweeps 2-4 record one, two, three moves per MAC: not yet flapping. The
  // fifth sweep is the fourth move (MIN_MOVES_PER_MAC), and it fires; the
  // sixth is inside the refractory period.
  assert.deepEqual(loops, [0, 0, 0, 0, 1, 0]);
  assert.equal(fdbEntriesRepo.moves.length, 20, 'every move was recorded');
  assert.equal(findingStore.rows.length, 1);
});
