'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Stage 02: the SNMP device inventory, the topology ingest, and the `port` hit
// that comes out the other end.
//
// The one property worth protecting above all others here is OWNERSHIP: an
// agent may only write the forwarding table of a device the server assigned to
// IT. Without that, any agent token could rewrite where any switch thinks its
// MACs are — which is not just a data-integrity problem, it is a way to make a
// technician walk to the wrong building.
//
// The second is the CREDENTIAL: a community string is a password in clear text
// on the wire (the protocol's fault) and must never come back out of an API.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeSnmpDevicesRepo,
  makeFdbEntriesRepo,
  makeSnmpNeighborsRepo,
  makeAgentCommander,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const agentToken = (agentId = 9) => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: agentId }) });

const agentsRepo = () => makeAgentsRepo({
  findAll: async () => ([
    { id: 9, hostname: 'be-aarhus-01', display_name: 'Aarhus collector' },
    { id: 11, hostname: 'be-vejle-01', display_name: null },
  ]),
  findById: async (id) => ([9, 11].includes(Number(id)) ? { id: Number(id), hostname: `agent-${id}` } : null),
});

// A fleet where agent 9 polls sw-core-1 and agent 11 polls sw-lager-1.
async function seededDevices() {
  const repo = makeSnmpDevicesRepo();
  await repo.create({ agentId: 9, host: '10.14.0.11', displayName: 'Core switch', community: 'public' });
  await repo.create({ agentId: 11, host: '10.22.0.5', displayName: 'Lager switch', community: 'secret' });
  return repo;
}

const FDB = (over = {}) => ({
  mac: '00:1b:44:11:3a:b7', vlan: 20, bridgePort: 2,
  ifIndex: 10002, ifName: 'GigabitEthernet0/2', status: 'learned', portMacCount: 1, ...over,
});

const post = (app, body, token = 'agent-tok') => request(app)
  .post('/agents/me/snmp-topology')
  .set('Authorization', `Bearer ${token}`)
  .send(body);

const get = (app, path, role = 'viewer') =>
  request(app).get(path).set('Authorization', authHeader(role));

// ============================================================ the ingest
test('POST /agents/me/snmp-topology requires an agent token', async () => {
  const app = makeApp({ agentTokensRepo: agentToken(), snmpDevicesRepo: await seededDevices() });
  assert.equal((await request(app).post('/agents/me/snmp-topology').send({ devices: [] })).status, 401);
});

test('a body without devices is 400 — that is malformed, not "polled nothing"', async () => {
  // The agent's poller only submits when it has something to say, so it always
  // sends the key. Defaulting it would make a truncated POST look like a
  // successful empty cycle, which nobody can tell from the outside.
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), snmpDevicesRepo: await seededDevices() });
  for (const body of [{}, { devices: 'lots' }, { devices: {} }]) {
    assert.equal((await post(app, body)).status, 400, JSON.stringify(body));
  }
});

test('no ingest configured answers 503, not a 202 into nowhere', async () => {
  const app = makeApp({
    agentsRepo: agentsRepo(), agentTokensRepo: agentToken(),
    snmpDevicesRepo: await seededDevices(), snmpTopologyIngest: null,
  });
  assert.equal((await post(app, { devices: [{ deviceId: 1, fdb: [FDB()] }] })).status, 503);
});

test('a forwarding table lands against the device that reported it', async () => {
  const snmpDevicesRepo = await seededDevices();
  const fdbEntriesRepo = makeFdbEntriesRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo, fdbEntriesRepo });

  const res = await post(app, {
    devices: [{ deviceId: 1, fdb: [FDB()], supported: ['if', 'fdb'] }],
    errors: [],
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.stored, 1);
  assert.equal(res.body.fdbRows, 1);
  assert.equal(res.body.refused, 0);

  assert.equal(fdbEntriesRepo.rows.length, 1);
  assert.equal(fdbEntriesRepo.rows[0].device_id, 1);
  assert.equal(fdbEntriesRepo.rows[0].if_name, 'GigabitEthernet0/2');

  const device = await snmpDevicesRepo.findById(1);
  assert.ok(device.lastOkAt, 'a successful poll is stamped');
  assert.equal(device.lastError, null);
  assert.deepEqual(device.supported, ['if', 'fdb']);
});

// ------------------------------------------------------------- OWNERSHIP
test('an agent CANNOT write a device it does not poll', async () => {
  // THE security test in this file. Agent 9 polls device 1; device 2 belongs to
  // agent 11. Without this check any agent token could rewrite any switch's
  // forwarding table and send a technician to the wrong building.
  const snmpDevicesRepo = await seededDevices();
  const fdbEntriesRepo = makeFdbEntriesRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo, fdbEntriesRepo });

  const res = await post(app, {
    devices: [{ deviceId: 2, fdb: [FDB()] }],
    errors: [],
  });
  assert.equal(res.status, 202, 'the batch is accepted');
  assert.equal(res.body.stored, 0);
  assert.equal(res.body.refused, 1, 'and the device is refused');
  assert.equal(fdbEntriesRepo.rows.length, 0, 'nothing was written');
});

test('a mixed batch keeps what the agent owns and refuses the rest', async () => {
  // An assignment that changed mid-cycle is a normal race, not an attack: the
  // owned devices still store.
  const snmpDevicesRepo = await seededDevices();
  const fdbEntriesRepo = makeFdbEntriesRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo, fdbEntriesRepo });

  const res = await post(app, {
    devices: [{ deviceId: 1, fdb: [FDB()] }, { deviceId: 2, fdb: [FDB()] }],
    errors: [],
  });
  assert.equal(res.body.stored, 1);
  assert.equal(res.body.refused, 1);
  assert.equal(fdbEntriesRepo.rows.length, 1);
  assert.equal(fdbEntriesRepo.rows[0].device_id, 1);
});

test('a per-device failure is recorded but keeps the last good time', async () => {
  // "Last answered 41 minutes ago" is the difference between a switch that
  // blipped and one that is gone.
  const snmpDevicesRepo = await seededDevices();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo });

  await post(app, { devices: [{ deviceId: 1, fdb: [FDB()] }], errors: [] });
  const okAt = (await snmpDevicesRepo.findById(1)).lastOkAt;
  assert.ok(okAt);

  const res = await post(app, { devices: [], errors: [{ deviceId: 1, error: 'Timeout', code: 'SNMP_TIMEOUT' }] });
  assert.equal(res.body.failuresRecorded, 1);

  const device = await snmpDevicesRepo.findById(1);
  assert.equal(device.lastError, 'Timeout');
  assert.equal(device.lastOkAt, okAt, 'the last good time survives the failure');
});

test('a failure for a device the agent does not poll is refused too', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo: await seededDevices() });
  const res = await post(app, { devices: [], errors: [{ deviceId: 2, error: 'Timeout' }] });
  assert.equal(res.body.failuresRecorded, 0);
  assert.equal(res.body.refused, 1);
});

test('one device failing to store does not lose the others', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11' });
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.12' });
  const fdbEntriesRepo = makeFdbEntriesRepo({
    upsertMany: async (deviceId, entries) => {
      if (Number(deviceId) === 1) throw new Error('deadlock');
      return entries.length;
    },
  });
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo, fdbEntriesRepo });

  const res = await post(app, {
    devices: [{ deviceId: 1, fdb: [FDB()] }, { deviceId: 2, fdb: [FDB()] }],
    errors: [],
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.stored, 1);
  assert.equal(res.body.deviceErrors.length, 1);
  assert.equal(res.body.deviceErrors[0].deviceId, 1);
  // The failure is also recorded on the device, so the dashboard shows a reason
  // rather than a device that silently stopped updating.
  assert.match((await snmpDevicesRepo.findById(1)).lastError, /deadlock/);
});

test('a neighbour ingest failure does not cost the forwarding table', async () => {
  // The port table is the part somebody is waiting for.
  const fdbEntriesRepo = makeFdbEntriesRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(),
    agentTokensRepo: agentToken(9),
    snmpDevicesRepo: await seededDevices(),
    fdbEntriesRepo,
    snmpNeighborsRepo: makeSnmpNeighborsRepo({ upsertMany: throwingAsync('neighbours down') }),
  });
  const res = await post(app, {
    devices: [{
      deviceId: 1,
      fdb: [FDB()],
      neighbours: [{ remoteChassisId: 'aa:bb:cc:11:22:33', remotePortId: 'Gi1/0/5' }],
    }],
    errors: [],
  });
  assert.equal(res.body.stored, 1);
  assert.equal(res.body.fdbRows, 1);
  assert.equal(res.body.neighbourRows, 0);
});

test('a MAC that MOVED rewrites its port rather than accumulating rows', async () => {
  const fdbEntriesRepo = makeFdbEntriesRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo: await seededDevices(), fdbEntriesRepo });

  await post(app, { devices: [{ deviceId: 1, fdb: [FDB({ bridgePort: 2, ifName: 'Gi0/2' })] }], errors: [] });
  await post(app, { devices: [{ deviceId: 1, fdb: [FDB({ bridgePort: 7, ifName: 'Gi0/7' })] }], errors: [] });

  assert.equal(fdbEntriesRepo.rows.length, 1, 'one row, not a history');
  assert.equal(fdbEntriesRepo.rows[0].if_name, 'Gi0/7');
});

// ============================================== the agent config handout
test('the agent config carries the switches assigned to that agent', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo: await seededDevices() });
  const res = await request(app).get('/agents/me/config').set('Authorization', 'Bearer agent-tok');
  assert.equal(res.status, 200);
  assert.equal(res.body.snmpTargets.length, 1, 'only this agent’s devices');
  assert.equal(res.body.snmpTargets[0].host, '10.14.0.11');
  // The ONE path that carries the credential: the agent that does the polling.
  assert.equal(res.body.snmpTargets[0].community, 'public');
  // And the traffic source is untouched — the 1:1 binding is not replaced.
  assert.deepEqual(res.body.monitorConfig, { source: 'proc' });
});

test('a target with no usable community is sent WITH the reason, never with "public"', async () => {
  // The target is still handed over: "sw-lager-1: no SNMP community assigned"
  // on the dashboard is worth far more than a switch that silently never
  // appears. The agent refuses it — see blueeye-agent snmpPoller.credentialError.
  const { makeSnmpProfilesRepo } = require('../test-support/fakes');
  const snmpProfilesRepo = makeSnmpProfilesRepo();
  // Valid at the site, but NOT granted to agent 9.
  await snmpProfilesRepo.create({ name: 'Aarhus', version: '2c', community: 'aarhussecret', locationIds: [3], agentIds: [] });
  const snmpDevicesRepo = makeSnmpDevicesRepo({}, { credentialProfilesRepo: snmpProfilesRepo });
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11', locationId: 3 });

  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo, snmpProfilesRepo });
  const res = await request(app).get('/agents/me/config').set('Authorization', 'Bearer agent-tok');
  assert.equal(res.status, 200);
  const [target] = res.body.snmpTargets;
  assert.equal(target.community, null, 'never a quiet fallback to "public"');
  assert.equal(target.noCredential, true);
  assert.equal(target.credentialBlocked, true, 'this agent is not assigned the one its site has');
  assert.ok(!JSON.stringify(res.body).includes('aarhussecret'));
});

test('an agent with no assigned switches gets no key at all', async () => {
  // An agent too old to understand it must see exactly what it saw before.
  const repo = makeSnmpDevicesRepo();
  await repo.create({ agentId: 11, host: '10.22.0.5' });
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(9), snmpDevicesRepo: repo });
  const res = await request(app).get('/agents/me/config').set('Authorization', 'Bearer agent-tok');
  assert.equal(res.status, 200);
  assert.equal(res.body.snmpTargets, undefined);
});

test('a device inventory that cannot be read does not break the agent config', async () => {
  // Learning how to measure itself is the config's original and more important
  // job; a broken device list must not take it down.
  const app = makeApp({
    agentsRepo: agentsRepo(),
    agentTokensRepo: agentToken(9),
    snmpDevicesRepo: makeSnmpDevicesRepo({ listForAgentWithSecret: throwingAsync('devices down') }),
  });
  const res = await request(app).get('/agents/me/config').set('Authorization', 'Bearer agent-tok');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.monitorConfig, { source: 'proc' });
});

// ============================================================ the inventory API
test('GET /api/snmp-devices is 401 without a token and 200 for a viewer', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices() });
  assert.equal((await request(app).get('/api/snmp-devices')).status, 401);
  const res = await get(app, '/api/snmp-devices');
  assert.equal(res.status, 200);
  assert.equal(res.body.devices.length, 2);
  assert.equal(res.body.devices[0].agentName, 'Aarhus collector');
});

test('the community string NEVER comes back out of the API', async () => {
  // It is a password in clear text on the wire — the protocol's fault, which we
  // cannot fix. What we can refuse is handing it back on a GET.
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices() });
  const list = await get(app, '/api/snmp-devices');
  const one = await get(app, '/api/snmp-devices/1');
  const bodies = [JSON.stringify(list.body), JSON.stringify(one.body)];
  for (const body of bodies) {
    assert.ok(!body.includes('community'), 'no community key');
    assert.ok(!body.includes('public'), 'and not the value either');
  }
});

test('adding a device is admin-only', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: makeSnmpDevicesRepo() });
  const body = { host: '10.14.0.11', community: 'public', agentId: 9 };
  assert.equal((await request(app).post('/api/snmp-devices').send(body)).status, 401);
  for (const role of ['viewer', 'operator']) {
    const res = await request(app).post('/api/snmp-devices').set('Authorization', authHeader(role)).send(body);
    assert.equal(res.status, 403, role);
  }
  const ok = await request(app).post('/api/snmp-devices').set('Authorization', authHeader('admin')).send(body);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.device.host, '10.14.0.11');
});

test('an address the server must never poll is refused', async () => {
  // Loopback would reach BlueEye's own API; 169.254.169.254 is cloud metadata.
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: makeSnmpDevicesRepo() });
  for (const host of ['127.0.0.1', 'localhost', '169.254.169.254', '0.0.0.0']) {
    const res = await request(app).post('/api/snmp-devices')
      .set('Authorization', authHeader('admin')).send({ host });
    assert.equal(res.status, 400, host);
    assert.ok(res.body.details.host);
  }
});

test('an RFC1918 address is NOT refused — that is where switches live', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: makeSnmpDevicesRepo() });
  for (const host of ['10.14.0.11', '192.168.1.1', '172.16.5.4', 'sw-core-1.kunde.local']) {
    const res = await request(app).post('/api/snmp-devices')
      .set('Authorization', authHeader('admin')).send({ host });
    assert.equal(res.status, 201, host);
  }
});

test('the same address and port twice is 409, not a second row', async () => {
  // Two admins adding the same switch would otherwise double every poll and
  // split its history.
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices() });
  const res = await request(app).post('/api/snmp-devices')
    .set('Authorization', authHeader('admin')).send({ host: '10.14.0.11' });
  assert.equal(res.status, 409);
  assert.equal(res.body.deviceId, 1);
});

test('assigning a device to an agent nobody has is 404', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: makeSnmpDevicesRepo() });
  const res = await request(app).post('/api/snmp-devices')
    .set('Authorization', authHeader('admin')).send({ host: '10.14.0.11', agentId: 999 });
  assert.equal(res.status, 404);
});

test('a device nobody has is 404 on read, patch, delete and poll', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices(), agentCommander: makeAgentCommander() });
  assert.equal((await get(app, '/api/snmp-devices/999')).status, 404);
  assert.equal((await request(app).patch('/api/snmp-devices/999').set('Authorization', authHeader('admin')).send({ displayName: 'x' })).status, 404);
  assert.equal((await request(app).delete('/api/snmp-devices/999').set('Authorization', authHeader('admin'))).status, 404);
  assert.equal((await request(app).post('/api/snmp-devices/999/poll').set('Authorization', authHeader('operator'))).status, 404);
});

test('a non-numeric id is 400, not 404', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices() });
  assert.equal((await get(app, '/api/snmp-devices/abc')).status, 400);
});

test('editing a display name does not wipe the credential', async () => {
  // The community cannot be read back, so an omitted one must leave the stored
  // value alone — otherwise every rename silently breaks polling.
  const snmpDevicesRepo = await seededDevices();
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo });
  const res = await request(app).patch('/api/snmp-devices/1')
    .set('Authorization', authHeader('admin')).send({ displayName: 'Renamed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.device.displayName, 'Renamed');
  const [withSecret] = await snmpDevicesRepo.listForAgentWithSecret(9);
  assert.equal(withSecret.community, 'public', 'the credential survived the rename');
});

test('poll-now is operator+, 202, and 409 when the agent is not connected', async () => {
  const snmpDevicesRepo = await seededDevices();
  const app = makeApp({
    agentsRepo: agentsRepo(),
    snmpDevicesRepo,
    agentCommander: makeAgentCommander({ sendCommand: () => true }),
  });
  assert.equal((await request(app).post('/api/snmp-devices/1/poll').set('Authorization', authHeader('viewer'))).status, 403);
  const ok = await request(app).post('/api/snmp-devices/1/poll').set('Authorization', authHeader('operator'));
  assert.equal(ok.status, 202, 'the agent does the polling; the table refreshes a moment later');

  const offline = makeApp({
    agentsRepo: agentsRepo(), snmpDevicesRepo,
    agentCommander: makeAgentCommander({ sendCommand: () => false }),
  });
  assert.equal((await request(offline).post('/api/snmp-devices/1/poll').set('Authorization', authHeader('operator'))).status, 409);
});

test('poll-now on an unassigned device is 409, not a silent no-op', async () => {
  const repo = makeSnmpDevicesRepo();
  await repo.create({ host: '10.14.0.11' }); // no agentId
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: repo, agentCommander: makeAgentCommander() });
  const res = await request(app).post('/api/snmp-devices/1/poll').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 409);
});

test('a repository failure surfaces as 500', async () => {
  const app = makeApp({
    agentsRepo: agentsRepo(),
    snmpDevicesRepo: makeSnmpDevicesRepo({ list: throwingAsync('snmp_devices down') }),
  });
  assert.equal((await get(app, '/api/snmp-devices')).status, 500);
});

test('a failing port table still lets the device page open', async () => {
  const app = makeApp({
    agentsRepo: agentsRepo(),
    snmpDevicesRepo: await seededDevices(),
    fdbEntriesRepo: makeFdbEntriesRepo({ listForDevice: throwingAsync('fdb down') }),
  });
  const res = await get(app, '/api/snmp-devices/1');
  assert.equal(res.status, 200, 'the poll state and the error are still worth seeing');
  assert.deepEqual(res.body.fdb, []);
});

// ============================================== the payoff: search by MAC
test('searching a MAC returns the switch PORT it is on', async () => {
  // The whole point of the stage. Everything else on the search screen tells a
  // technician WHAT the device is; this tells them WHERE TO WALK.
  const fdbEntriesRepo = makeFdbEntriesRepo();
  await fdbEntriesRepo.upsertMany(1, [FDB()]);
  fdbEntriesRepo.rows[0].device_name = 'Core switch';

  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices(), fdbEntriesRepo });
  const res = await get(app, '/api/search?q=00%3A1b%3A44%3A11%3A3a%3Ab7');
  assert.equal(res.status, 200);

  const port = res.body.hits.find((h) => h.type === 'port');
  assert.ok(port, 'a port hit is returned');
  assert.equal(port.display_name, 'Core switch GigabitEthernet0/2');
  assert.equal(port.confidence, 'exact');
  assert.equal(port.source, 'fdb_entries (snmp)');
  assert.ok(port.last_seen, 'and it is dated, so a stale answer reads as stale');
  assert.match(port.detail, /VLAN 20/);
  assert.match(port.detail, /one MAC on this port/);
});

test('a MAC spelled any of the usual ways finds the same port', async () => {
  // The query is normalised with the SAME function the ingest uses, which is
  // what makes five spellings resolve identically.
  const fdbEntriesRepo = makeFdbEntriesRepo();
  await fdbEntriesRepo.upsertMany(1, [FDB()]);
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices(), fdbEntriesRepo });

  for (const spelling of ['00-1B-44-11-3A-B7', '001b.4411.3ab7', '001B44113AB7']) {
    const res = await get(app, `/api/search?q=${encodeURIComponent(spelling)}`);
    assert.ok(res.body.hits.some((h) => h.type === 'port'), spelling);
  }
});

test('a crowded port says it is likely an uplink', async () => {
  // One MAC means a patch panel to walk to; forty means one more hop to go.
  // Without that the hit is a lead, not an answer.
  const fdbEntriesRepo = makeFdbEntriesRepo();
  await fdbEntriesRepo.upsertMany(1, [FDB({ portMacCount: 40 })]);
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices(), fdbEntriesRepo });
  const res = await get(app, '/api/search?q=00%3A1b%3A44%3A11%3A3a%3Ab7');
  assert.match(res.body.hits.find((h) => h.type === 'port').detail, /40 MACs on this port — likely an uplink/);
});

test('a port the switch could not name says so rather than inventing one', async () => {
  const fdbEntriesRepo = makeFdbEntriesRepo();
  await fdbEntriesRepo.upsertMany(1, [FDB({ ifName: null, ifIndex: null })]);
  const app = makeApp({ agentsRepo: agentsRepo(), snmpDevicesRepo: await seededDevices(), fdbEntriesRepo });
  const hit = (await get(app, '/api/search?q=00%3A1b%3A44%3A11%3A3a%3Ab7')).body.hits.find((h) => h.type === 'port');
  assert.match(hit.display_name, /bridge port 2/);
  assert.match(hit.detail, /did not name this port/);
});

test('a forwarding-table lookup that fails costs that source, not the search', async () => {
  const app = makeApp({
    agentsRepo: agentsRepo(),
    snmpDevicesRepo: await seededDevices(),
    fdbEntriesRepo: makeFdbEntriesRepo({ findByMac: throwingAsync('fdb down') }),
  });
  const res = await get(app, '/api/search?q=00%3A1b%3A44%3A11%3A3a%3Ab7');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.hits));
});
