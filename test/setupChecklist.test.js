'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// "Why is this screen empty?" — answered once for the whole product.
//
// The rules that matter are the ones about what this must NOT claim. A
// checklist is only worth reading while every row on it is true, and the two
// ways to break that are inventing work (reporting a source that could not be
// read as zero) and inventing completion (calling something done that was
// never checked).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildSetupChecklist, FLOW_SOURCES } = require('../src/services/setupChecklist');
const {
  makeApp, makeAgentsRepo, makeSnmpDevicesRepo, makeSnmpProfilesRepo,
  makeLocationsRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');

const byKey = (result, key) => result.checks.find((c) => c.key === key);
const AGENT = (over = {}) => ({ id: 1, status: 'online', monitor_config: { source: 'proc' }, ...over });

// ============================================================ never invents
test('a source that could not be read is UNKNOWN, never zero', () => {
  // Reporting an unreadable store as zero puts a task on the list that nobody
  // needs to do, and a checklist with invented work on it is one people stop
  // reading.
  const r = buildSetupChecklist({
    agents: [AGENT()],
    snmpDevices: [{ id: 1, enabled: true, agentId: 1, locationId: 3 }],
    credentialed: null,
    deviceEvents: null,
    geoipRanges: null,
  });
  assert.equal(byKey(r, 'snmpCredentials').state, 'unknown');
  assert.equal(byKey(r, 'geoip').state, 'unknown');
});

test('nothing in the device log is UNKNOWN, not TODO', () => {
  // This server cannot see whether an agent's syslog receiver is listening —
  // that is local config on the host. "Nothing arrived" is equally consistent
  // with a receiver that is off and a network that has been quiet, and
  // reporting the first as fact would be a claim the data does not support.
  const quiet = buildSetupChecklist({ agents: [AGENT()], deviceEvents: 0 });
  assert.equal(byKey(quiet, 'deviceLog').state, 'unknown');

  const busy = buildSetupChecklist({ agents: [AGENT()], deviceEvents: 41 });
  assert.equal(byKey(busy, 'deviceLog').state, 'ok');
  assert.equal(byKey(busy, 'deviceLog').detail.events, 41);
});

test('an UNKNOWN row never holds the checklist open', () => {
  // The Device log can never be PROVEN set up from here. A checklist that can
  // never finish is one people learn to ignore.
  const r = buildSetupChecklist({
    agents: [AGENT({ monitor_config: { source: 'sflow' } })],
    snmpDevices: [],
    deviceEvents: 0,
    geoipRanges: 1000,
    locations: [{ id: 1, latitude: 56.1, longitude: 10.2 }],
  });
  assert.equal(byKey(r, 'deviceLog').state, 'unknown');
  assert.equal(byKey(r, 'snmpDevices').state, 'todo', 'the real task is still outstanding');
  assert.equal(r.complete, false);

  const done = buildSetupChecklist({
    agents: [AGENT({ monitor_config: { source: 'sflow' } })],
    snmpDevices: [{ id: 1, enabled: true, agentId: 1, locationId: 3 }],
    credentialed: 1,
    deviceEvents: 0,
    geoipRanges: 1000,
    locations: [{ id: 1, latitude: 56.1, longitude: 10.2 }],
  });
  assert.equal(byKey(done, 'deviceLog').state, 'unknown');
  assert.equal(done.complete, true, 'an unknown is not outstanding work');
});

// ======================================================== the flow source
test('proc is not a flow source, however many agents run it', () => {
  // The single most common reason a screen is empty here, and the one nobody
  // guesses: an sFlow exporter on the HOST does nothing until the agent is
  // told to collect it.
  const r = buildSetupChecklist({
    agents: [AGENT({ id: 1 }), AGENT({ id: 2 }), AGENT({ id: 3, monitor_config: { source: 'snmp' } })],
  });
  const check = byKey(r, 'flowSource');
  assert.equal(check.state, 'todo');
  assert.equal(check.detail.flowAgents, 0);
  assert.equal(check.detail.total, 3);
  // And it names the screens that stay empty, which is the half that was
  // missing every time somebody went looking for a bug in a working screen.
  assert.ok(check.unlocks.includes('flows'));
});

test('one agent on sFlow is enough to call it done', () => {
  const r = buildSetupChecklist({
    agents: [AGENT({ id: 1 }), AGENT({ id: 2, monitor_config: { source: 'sflow' } })],
  });
  assert.equal(byKey(r, 'flowSource').state, 'ok');
  assert.deepEqual(FLOW_SOURCES, ['netflow', 'sflow']);
});

// ============================================================== partly done
test('some but not all is PARTLY, and says how many', () => {
  // "Two of your nine switches are polled" is a different problem from none of
  // them, and it is the one that looks like everything is fine.
  const r = buildSetupChecklist({
    agents: [AGENT()],
    snmpDevices: [
      { id: 1, enabled: true, agentId: 1, locationId: 3 },
      { id: 2, enabled: true, agentId: 1, locationId: null },
      { id: 3, enabled: true, agentId: 1, locationId: 4 },
    ],
    credentialed: 2,
  });
  const creds = byKey(r, 'snmpCredentials');
  assert.equal(creds.state, 'partial');
  assert.deepEqual(creds.detail, { credentialed: 2, devices: 3 });

  const sites = byKey(r, 'snmpSites');
  assert.equal(sites.state, 'partial');
  assert.equal(sites.detail.sited, 2);
});

test('a disabled switch is not counted as work', () => {
  // Somebody turned it off. Listing it as an unpolled device would put a task
  // on the list whose correct resolution is "do nothing".
  const r = buildSetupChecklist({
    agents: [AGENT()],
    snmpDevices: [{ id: 1, enabled: false }],
  });
  assert.equal(byKey(r, 'snmpDevices').state, 'todo');
  assert.equal(byKey(r, 'snmpDevices').detail.enabled, 0);
  assert.equal(byKey(r, 'snmpCredentials'), undefined, 'no devices, no credential row');
});

test('enrolled but all offline is PARTLY, not done', () => {
  const r = buildSetupChecklist({ agents: [AGENT({ status: 'offline' })] });
  assert.equal(byKey(r, 'agents').state, 'partial');
});

test('garbage in is a checklist, not a throw', () => {
  for (const bad of [undefined, null, {}, { agents: 'no' }, { snmpDevices: [null, 7] }, { locations: 3 }]) {
    assert.doesNotThrow(() => buildSetupChecklist(bad), JSON.stringify(bad));
  }
  assert.ok(buildSetupChecklist(null).checks.length >= 6);
});

// ================================================================== the API
const adminGet = (app, path) => request(app).get(path).set('Authorization', authHeader('admin'));

test('the checklist is admin-only', async () => {
  // The rows describe how this install is wired — which agents exist, whether
  // any switch has a usable credential. That is a map of the monitoring for
  // anyone who can read it, and only an admin can act on it.
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findAll: async () => [AGENT()] }) });
  for (const role of ['viewer', 'operator']) {
    assert.equal((await request(app).get('/api/setup/checklist').set('Authorization', authHeader(role))).status, 403, role);
  }
  assert.equal((await request(app).get('/api/setup/checklist')).status, 401);
  assert.equal((await adminGet(app, '/api/setup/checklist')).status, 200);
});

test('the checklist answers on an install with nothing wired up', async () => {
  // Exactly the install that needs it. An endpoint that 500s on an empty
  // database is one nobody sees until they no longer need it.
  const app = makeApp({});
  const res = await adminGet(app, '/api/setup/checklist');
  assert.equal(res.status, 200);
  assert.ok(res.body.checks.length >= 6);
  assert.equal(res.body.complete, false);
});

test('a repository that throws costs its row, never the page', async () => {
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findAll: throwingAsync() }),
    locationsRepo: makeLocationsRepo({ findAll: throwingAsync() }),
  });
  const res = await adminGet(app, '/api/setup/checklist');
  assert.equal(res.status, 200, 'best-effort: a broken source must not take the screen down');
  assert.equal(res.body.checks.find((c) => c.key === 'agents').state, 'todo');
});

test('a switch with its OWN community counts as credentialed', async () => {
  // It needs nothing resolved — the device carries the credential itself.
  const snmpProfilesRepo = makeSnmpProfilesRepo();
  const snmpDevicesRepo = makeSnmpDevicesRepo({}, { credentialProfilesRepo: snmpProfilesRepo });
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11', community: 'ownsecret' });

  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => [AGENT({ id: 9 })] }),
    snmpDevicesRepo,
    snmpProfilesRepo,
  });
  const res = await adminGet(app, '/api/setup/checklist');
  const creds = res.body.checks.find((c) => c.key === 'snmpCredentials');
  assert.equal(creds.state, 'ok');
  assert.equal(creds.detail.credentialed, 1);
});

test('a switch whose agent is not granted the community is NOT credentialed', async () => {
  // The rule the whole SNMP communities feature rests on, checked end to end:
  // a community valid at the site that this agent may not use is not a
  // credential this device has.
  const snmpProfilesRepo = makeSnmpProfilesRepo();
  await snmpProfilesRepo.create({ name: 'Aarhus', version: '2c', community: 'x', locationIds: [3], agentIds: [] });
  const snmpDevicesRepo = makeSnmpDevicesRepo({}, { credentialProfilesRepo: snmpProfilesRepo });
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11', locationId: 3 });

  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => [AGENT({ id: 9 })] }),
    snmpDevicesRepo,
    snmpProfilesRepo,
  });
  const res = await adminGet(app, '/api/setup/checklist');
  const creds = res.body.checks.find((c) => c.key === 'snmpCredentials');
  assert.equal(creds.state, 'todo');
  assert.equal(creds.detail.credentialed, 0);
});
