'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Trin 3, server side: counters bound to a DEVICE and a PORT, over time.
//
// The ingest is the first one here that has to look backwards — a counter is
// meaningless alone, so every cycle reads the previous reading per port before
// it writes. That makes three things worth protecting, and all three produce a
// plausible-looking number when they go wrong:
//
//   * a sample must resolve to a PORT ROW, never to an ifIndex
//   * a reboot, a renumbering or a bad gap must void the RATE, not the reading
//   * an agent may only write the devices assigned to it

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeSnmpDevicesRepo,
  makeDeviceInterfacesRepo,
  makeCounterSamplesRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const agentToken = (agentId = 9) => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: agentId }) });

const agentsRepo = () => makeAgentsRepo({
  findAll: async () => ([{ id: 9, hostname: 'be-aarhus-01' }]),
  findById: async (id) => (Number(id) === 9 ? { id: 9, hostname: 'be-aarhus-01' } : null),
});

async function seededDevices() {
  const repo = makeSnmpDevicesRepo();
  await repo.create({
    agentId: 9, host: '10.14.0.11', displayName: 'Core switch', community: 'public',
    collect: ['if', 'fdb', 'ifcounters'], counterIntervalSec: 60,
  });
  await repo.create({ agentId: 11, host: '10.22.0.5', displayName: 'Lager switch' });
  return repo;
}

// A fleet with one switch, one port, and the port inventory already populated —
// which is the precondition for a counter sample to mean anything.
async function seeded({ speedMbps = 1000 } = {}) {
  const snmpDevicesRepo = await seededDevices();
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  const counterSamplesRepo = makeCounterSamplesRepo();
  await deviceInterfacesRepo.upsertMany(1, [
    { ifName: 'Gi0/1', ifIndex: 1, speedMbps, ifAlias: 'uplink', operStatus: 'up' },
    { ifName: 'Gi0/2', ifIndex: 2, speedMbps, operStatus: 'down' },
  ]);
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(),
    snmpDevicesRepo, deviceInterfacesRepo, counterSamplesRepo,
  });
  return { app, snmpDevicesRepo, deviceInterfacesRepo, counterSamplesRepo };
}

const IF = (over = {}) => ({
  ifIndex: 1, ifName: 'Gi0/1',
  inOctets: 1_000_000, outOctets: 500_000,
  inErrors: 10, outErrors: 0, inDiscards: 2, outDiscards: 0,
  fcsErrors: 0, inBcastPkts: 100, ...over,
});

const submit = (app, body) => request(app)
  .post('/agents/me/snmp-counters')
  .set('Authorization', 'Bearer agent-tok')
  .send(body);

const cycle = (app, { deviceId = 1, readAt, interfaces, ticks = 500_000, ...rest } = {}) =>
  submit(app, { devices: [{ deviceId, readAt, sysUpTimeTicks: ticks, hc: true, interfaces, ...rest }] });

const get = (app, path, role = 'viewer') => request(app).get(path).set('Authorization', authHeader(role));

// RELATIVE to now, one minute apart, not a fixed date. The previous-sample
// read is a window that ends at the current time, so a hard-coded timestamp
// ages out of it during the day and the test starts failing by the clock
// rather than by the code.
//
// BOTH FROM ONE `Date.now()`. Two calls are two readings of a clock that may
// tick between them, which makes the interval 60.001 seconds — and every rate
// asserted against it comes out a hair low (100 000 bps reads as 99 998.333).
// Intermittent, roughly one run in six, and it looks exactly like a rounding
// bug in the delta code rather than a fixture racing the clock.
const NOW = Date.now();
const T0 = new Date(NOW - 5 * 60 * 1000).toISOString();
const T1 = new Date(NOW - 4 * 60 * 1000).toISOString();

// ================================================================== the ingest
test('the first cycle stores raw counters and no rates', async () => {
  const { app, counterSamplesRepo } = await seeded();
  const res = await cycle(app, { readAt: T0, interfaces: [IF()] });
  assert.equal(res.status, 202);
  assert.equal(res.body.stored, 1);
  assert.equal(res.body.samples, 1);
  assert.equal(res.body.discontinuities.first, 1);

  const [row] = counterSamplesRepo.rows;
  assert.equal(row.inOctets, 1_000_000);
  assert.equal(row.inBps, null);
  assert.equal(row.discontinuity, 'first');
});

test('the second cycle produces the rate, against the port ROW', async () => {
  const { app, counterSamplesRepo, deviceInterfacesRepo } = await seeded();
  await cycle(app, { readAt: T0, interfaces: [IF()] });
  await cycle(app, { readAt: T1, ticks: 506_000, interfaces: [IF({ inOctets: 1_750_000, inErrors: 16 })] });

  assert.equal(counterSamplesRepo.rows.length, 2);
  const second = counterSamplesRepo.rows[1];
  assert.equal(second.deltaSec, 60);
  assert.equal(second.inBps, 100_000);
  assert.equal(second.inErrPps, 0.1);
  assert.equal(second.inUtilPct, 0.01);
  assert.equal(second.discontinuity, null);

  const portId = deviceInterfacesRepo.rows.find((r) => r.if_name === 'Gi0/1').id;
  assert.equal(second.interfaceId, portId, 'the sample points at the port row, not the ifIndex');
});

test('a counter for a port the inventory has never seen is DROPPED, not guessed at', async () => {
  // The sample would have nothing to be a measurement OF. The next topology
  // poll creates the row, and then it counts.
  const { app, counterSamplesRepo } = await seeded();
  const res = await cycle(app, { readAt: T0, interfaces: [IF({ ifIndex: 99, ifName: 'Gi0/99' })] });
  assert.equal(res.body.unresolved, 1);
  assert.equal(res.body.samples, 0);
  assert.equal(counterSamplesRepo.rows.length, 0);
});

test('a port is resolved by NAME first and ifIndex second', async () => {
  // The name is the identity (migration 108). The index is the fallback for a
  // device whose ifName column the agent could not read.
  const { app, counterSamplesRepo, deviceInterfacesRepo } = await seeded();
  await cycle(app, { readAt: T0, interfaces: [IF({ ifName: null, ifIndex: 2 })] });
  const portId = deviceInterfacesRepo.rows.find((r) => r.if_name === 'Gi0/2').id;
  assert.equal(counterSamplesRepo.rows[0].interfaceId, portId);
});

test('a renamed-but-same-index port follows the NAME, which is the whole point', async () => {
  const { app, counterSamplesRepo, deviceInterfacesRepo } = await seeded();
  // ifIndex 1 is Gi0/1 in the inventory; a sample naming Gi0/2 with index 1
  // belongs to Gi0/2.
  await cycle(app, { readAt: T0, interfaces: [IF({ ifName: 'Gi0/2', ifIndex: 1 })] });
  const gi2 = deviceInterfacesRepo.rows.find((r) => r.if_name === 'Gi0/2').id;
  assert.equal(counterSamplesRepo.rows[0].interfaceId, gi2);
});

// ================================================================ the reboot
test('a rebooted switch stores its counters and voids every rate', async () => {
  // The clamp everybody writes — Math.max(next - prev, 0) — would put a 0 here,
  // and 0 reads as "no traffic in that minute".
  const { app, counterSamplesRepo } = await seeded();
  await cycle(app, { readAt: T0, ticks: 5_000_000, interfaces: [IF()] });
  await cycle(app, { readAt: T1, ticks: 2_000, interfaces: [IF({ inOctets: 400 })] });

  const second = counterSamplesRepo.rows[1];
  assert.equal(second.inOctets, 400, 'the reading is kept');
  assert.equal(second.inBps, null);
  assert.equal(second.discontinuity, 'reboot');
});

test('a reboot BETWEEN two polls is caught — uptime rose, but not enough', async () => {
  // The switch rebooted at 12:00:10 and was back at 12:00:40. sysUpTime is
  // RISING at the 12:01 poll; it just rose by twenty seconds instead of sixty.
  const { app, counterSamplesRepo } = await seeded();
  await cycle(app, { readAt: T0, ticks: 5_000_000, interfaces: [IF()] });
  await cycle(app, { readAt: T1, ticks: 2_000, interfaces: [IF({ inOctets: 1_750_000 })] });
  assert.equal(counterSamplesRepo.rows[1].discontinuity, 'reboot');
});

test('the device clock is remembered on the DEVICE, for the next cycle', async () => {
  const { app, snmpDevicesRepo } = await seeded();
  await cycle(app, { readAt: T0, ticks: 5_000_000, interfaces: [IF()] });
  const device = await snmpDevicesRepo.findById(1);
  assert.equal(device.lastUptimeTicks, 5_000_000);
  assert.equal(device.lastUptimeAt, T0);
});

// ============================================================ the renumbering
test('a port whose ifIndex moved has its rate voided, not its reading', async () => {
  const { app, counterSamplesRepo } = await seeded();
  await cycle(app, { readAt: T0, interfaces: [IF()] });
  await cycle(app, {
    readAt: T1, ticks: 506_000,
    interfaces: [IF({ ifIndex: 49, inOctets: 1_750_000 })],
    renumbered: ['Gi0/1'],
  });
  const second = counterSamplesRepo.rows[1];
  assert.equal(second.inOctets, 1_750_000);
  assert.equal(second.inBps, null);
  assert.equal(second.discontinuity, 'renumber');
});

// ================================================================= the caps
test('a batch without devices is 400 — malformed, not "polled nothing"', async () => {
  const { app } = await seeded();
  for (const body of [{}, { devices: 'lots' }, { devices: {} }]) {
    assert.equal((await submit(app, body)).status, 400, JSON.stringify(body));
  }
});

test('a device row with no readAt is skipped — without it there is no rate', async () => {
  const { app } = await seeded();
  const res = await submit(app, { devices: [{ deviceId: 1, interfaces: [IF()] }] });
  assert.equal(res.status, 202);
  assert.equal(res.body.skipped, 1);
  assert.equal(res.body.stored, 0);
});

test('a negative or unreadable counter becomes NULL, never zero', async () => {
  const { app, counterSamplesRepo } = await seeded();
  await cycle(app, { readAt: T0, interfaces: [IF({ inErrors: -5, fcsErrors: 'lots' })] });
  assert.equal(counterSamplesRepo.rows[0].inErrors, null);
  assert.equal(counterSamplesRepo.rows[0].fcsErrors, null);
  assert.equal(counterSamplesRepo.rows[0].inOctets, 1_000_000, 'the readable ones are unaffected');
});

test('a resubmitted cycle does not double-count', async () => {
  const { app, counterSamplesRepo } = await seeded();
  await cycle(app, { readAt: T0, interfaces: [IF()] });
  await cycle(app, { readAt: T0, interfaces: [IF()] });
  assert.equal(counterSamplesRepo.rows.length, 1);
});

// ============================================================== the ownership
test('an agent cannot write counters for a device it does not poll', async () => {
  const { app, counterSamplesRepo } = await seeded();
  const res = await cycle(app, { deviceId: 2, readAt: T0, interfaces: [IF()] });
  assert.equal(res.body.refused, 1);
  assert.equal(counterSamplesRepo.rows.length, 0);
});

test('the endpoint needs an agent token', async () => {
  const { app } = await seeded();
  assert.equal((await request(app).post('/agents/me/snmp-counters').send({ devices: [] })).status, 401);
});

test('a per-device poll failure is recorded against the device', async () => {
  const { app, snmpDevicesRepo } = await seeded();
  const res = await submit(app, {
    devices: [],
    errors: [{ deviceId: 1, error: 'RequestTimedOutError', code: 'SNMP_TIMEOUT' }],
  });
  assert.equal(res.body.failuresRecorded, 1);
  const device = await snmpDevicesRepo.findById(1);
  assert.match(device.lastError, /RequestTimedOutError/);
});

// ==================================================================== reads
test('GET /:id/counters is the port table with its rates, viewer+', async () => {
  const { app } = await seeded();
  await cycle(app, { readAt: T0, interfaces: [IF()] });
  await cycle(app, { readAt: T1, ticks: 506_000, interfaces: [IF({ inOctets: 1_750_000 })] });

  assert.equal((await request(app).get('/api/snmp-devices/1/counters')).status, 401);
  const res = await get(app, '/api/snmp-devices/1/counters');
  assert.equal(res.status, 200);
  assert.equal(res.body.counters.length, 1);
  assert.equal(res.body.counters[0].ifName, 'Gi0/1');
  assert.equal(res.body.counters[0].ifAlias, 'uplink');
  assert.equal(res.body.counters[0].speedMbps, 1000);
  assert.equal(res.body.counters[0].inBps, 100_000);
});

test('GET a port series returns the window, newest last', async () => {
  const { app, deviceInterfacesRepo } = await seeded();
  const portId = deviceInterfacesRepo.rows.find((r) => r.if_name === 'Gi0/1').id;
  // RELATIVE to now, not a fixed date: the series read is a window ending at
  // the current time, so a hard-coded timestamp silently ages out of it and the
  // test starts failing by the clock rather than by the code.
  const base = Date.now() - 10 * 60_000;
  for (let i = 0; i < 5; i += 1) {
    await cycle(app, {
      readAt: new Date(base + i * 60_000).toISOString(),
      ticks: 500_000 + i * 6_000,
      interfaces: [IF({ inOctets: 1_000_000 + i * 750_000 })],
    });
  }
  const res = await get(app, `/api/snmp-devices/1/interfaces/${portId}/series?minutes=60`);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 5);
  assert.equal(res.body.samples[0].discontinuity, 'first');
  assert.equal(res.body.samples[4].inBps, 100_000);
});

test('a port from ANOTHER device is 404 on this device page', async () => {
  // Without the check, an interface id from another switch would return its
  // series under this device's page.
  const { app, deviceInterfacesRepo } = await seeded();
  await deviceInterfacesRepo.upsertMany(2, [{ ifName: 'Gi1/1', ifIndex: 1 }]);
  const otherPort = deviceInterfacesRepo.rows.find((r) => r.device_id === 2).id;
  assert.equal((await get(app, `/api/snmp-devices/1/interfaces/${otherPort}/series`)).status, 404);
});

test('unknown ids and bad windows answer honestly', async () => {
  const { app } = await seeded();
  assert.equal((await get(app, '/api/snmp-devices/999/counters')).status, 404);
  assert.equal((await get(app, '/api/snmp-devices/abc/counters')).status, 400);
  assert.equal((await get(app, '/api/snmp-devices/1/interfaces/abc/series')).status, 400);
  // An out-of-range window falls back to the default rather than 400: it is a
  // display choice, not a malformed request.
  const res = await get(app, '/api/snmp-devices/1/interfaces/1/series?minutes=999999');
  assert.equal(res.body.minutes, 240);
});

test('a repository failure is a 500, not an empty chart', async () => {
  const snmpDevicesRepo = await seededDevices();
  const app = makeApp({
    agentsRepo: agentsRepo(), snmpDevicesRepo,
    deviceInterfacesRepo: makeDeviceInterfacesRepo(),
    counterSamplesRepo: makeCounterSamplesRepo({ latestWithNames: throwingAsync('counters down') }),
  });
  assert.equal((await get(app, '/api/snmp-devices/1/counters')).status, 500);
});

test('with no counter store configured the reads say so, and do not pretend', async () => {
  // 503 is a different answer from an empty list: "not collecting" and
  // "collecting, nothing seen" send a technician to different places.
  const app = makeApp({
    agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices(),
    deviceInterfacesRepo: makeDeviceInterfacesRepo(),
    counterSamplesRepo: null,
  });
  assert.equal((await get(app, '/api/snmp-devices/1/counters')).status, 503);
  assert.equal((await get(app, '/api/snmp-devices/1/interfaces/1/series')).status, 503);
});
