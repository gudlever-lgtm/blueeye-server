'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// The read side: GET /api/device-events (+ /catalog).
//
//   viewer+, deliberately. This is the same data class as the Flows explorer
//   and the probe results a viewer already reads — device operational messages,
//   no payload, credentials masked on the agent before they left the host. A
//   technician who can see that a link went down should not need operator
//   rights to read the line where the switch says so.
//
// The route owns no analysis. What it must get right is the filtering, the
// severity inversion (LOWER is worse in syslog, which is why the parameter is
// named maxSeverity), and the difference between "no events" and "no such
// device".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeDeviceEventsRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const agentsRepo = () => makeAgentsRepo({
  findAll: async () => ([
    { id: 4, hostname: 'sw-core-1', display_name: 'Core switch' },
    { id: 9, hostname: 'be-aarhus-01', display_name: null },
  ]),
  findById: async (id) => ([4, 9].includes(Number(id)) ? { id: Number(id), hostname: `agent-${id}` } : null),
});

const get = (app, qs = '', role = 'viewer') =>
  request(app).get(`/api/device-events${qs}`).set('Authorization', authHeader(role));

// A repo seeded with a realistic minute of a switch falling over: a critical
// link-down, a warning OSPF drop, and a notice nobody needs to see first.
async function seeded() {
  const repo = makeDeviceEventsRepo();
  const now = Date.now();
  const at = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();
  await repo.createMany(9, [
    {
      sourceIp: '10.14.0.11', receivedAt: at(60), deviceTime: at(63), clockSkewMs: 3000,
      transport: 'syslog', facility: 23, severity: 2, eventType: 'link.down',
      deviceHostname: 'sw-core-1', tag: '%LINK-3-UPDOWN', ifname: 'GigabitEthernet0/1',
      summary: 'Interface GigabitEthernet0/1, changed state to down',
      raw: '<186>…', deviceId: 4, dedupKey: 'k1', occurrences: 1,
    },
    {
      sourceIp: '10.14.0.11', receivedAt: at(58), deviceTime: null, clockSkewMs: null,
      transport: 'syslog', facility: 23, severity: 4, eventType: 'ospf.adjacency_lost',
      deviceHostname: 'sw-core-1', tag: '%OSPF-5-ADJCHG', ifname: 'Gi0/1',
      summary: 'Nbr 10.14.0.9 on Gi0/1 from FULL to DOWN',
      raw: '<189>…', deviceId: 4, dedupKey: 'k2', occurrences: 3,
    },
    {
      sourceIp: '10.14.0.12', receivedAt: at(55), deviceTime: null, clockSkewMs: null,
      transport: 'syslog', facility: 23, severity: 5, eventType: 'stp.topology_change',
      deviceHostname: 'sw-acc-2', tag: '%SPANTREE', ifname: 'Gi0/24',
      summary: 'Topology change received on Gi0/24',
      raw: '<189>…', deviceId: null, dedupKey: 'k3', occurrences: 1,
    },
  ]);
  return repo;
}

// ------------------------------------------------------------------ auth
test('GET /api/device-events is 401 without a token', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  assert.equal((await request(app).get('/api/device-events')).status, 401);
});

test('a viewer may read the device log', async () => {
  // Deliberate: see the note at the top. Requiring operator here would mean the
  // person triaging the alert cannot read the line that explains it.
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  const res = await get(app);
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 3);
});

test('operator and admin may read it too', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  for (const role of ['operator', 'admin']) {
    assert.equal((await get(app, '', role)).status, 200, role);
  }
});

// ------------------------------------------------------------------ 400
test('an out-of-range filter is 400, not a silent clamp', async () => {
  // Silently clamping would answer a question nobody asked and look like data.
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  for (const qs of [
    '?minutes=999999', '?minutes=0', '?limit=0', '?limit=5000',
    '?maxSeverity=8', '?maxSeverity=-1', '?transport=pigeon',
    '?deviceId=all', '?offset=-1', '?eventType=NOT%20A%20TYPE',
  ]) {
    const res = await get(app, qs);
    assert.equal(res.status, 400, `expected 400 for ${qs}`);
  }
});

// ------------------------------------------------------------------ 404
test('filtering by a device nobody has is 404, not an empty list', async () => {
  // "No events" and "no such device" are different answers, and only one of
  // them means stop looking.
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  assert.equal((await get(app, '?deviceId=999')).status, 404);
  assert.equal((await get(app, '?agentId=999')).status, 404);
});

test('a device that exists but has no events is 200 with an empty list', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  const res = await get(app, '?deviceId=9');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.events, []);
});

// ------------------------------------------------------------------ 500
test('a repository failure surfaces as 500', async () => {
  const app = makeApp({
    agentsRepo: agentsRepo(),
    deviceEventsRepo: makeDeviceEventsRepo({ list: throwingAsync('device_events down') }),
  });
  assert.equal((await get(app)).status, 500);
});

test('a failing severity count costs the chips, never the log', async () => {
  // The counts are garnish on the page; the events are the page.
  const repo = await seeded();
  repo.severityCounts = throwingAsync('count failed');
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: repo });
  const res = await get(app);
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 3);
  assert.deepEqual(res.body.counts, []);
});

// ------------------------------------------------------------------ reading
test('events come back newest first, named and labelled', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  const { body } = await get(app);

  const [first] = body.events;
  assert.equal(first.eventType, 'stp.topology_change', 'newest first');

  const linkDown = body.events.find((e) => e.eventType === 'link.down');
  assert.equal(linkDown.deviceName, 'Core switch', 'the display name wins over the hostname');
  assert.equal(linkDown.agentName, 'be-aarhus-01', 'the agent falls back to its hostname');
  assert.equal(linkDown.severityName, 'crit');
  // The catalogue's label is the FALLBACK the dashboard shows for a type it
  // has no key for, so it is English like every other default here. What a
  // person reads comes from `devevt.type.*` in public/i18n.js and follows
  // the language switch.
  assert.equal(linkDown.typeLabel, 'Link down');
  assert.equal(linkDown.clockSkewMs, 3000);
});

test('an unresolved sender has no device name but keeps its address', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  const { body } = await get(app);
  const orphan = body.events.find((e) => e.deviceId == null);
  assert.equal(orphan.deviceName, null);
  assert.equal(orphan.sourceIp, '10.14.0.12');
  assert.equal(orphan.deviceHostname, 'sw-acc-2', "the device's own name survives");
});

test('an event_type this server does not know is shown raw, not hidden', async () => {
  // The agent ships the classifier and may be newer than the server. Refusing
  // what it did not recognise would mean an agent upgrade silently dropping the
  // events it just got better at spotting.
  const repo = makeDeviceEventsRepo();
  await repo.createMany(9, [{
    sourceIp: '10.14.0.11', receivedAt: new Date().toISOString(), transport: 'syslog',
    severity: 3, eventType: 'future.invention', summary: 'something new',
    deviceId: 4, dedupKey: 'k9', occurrences: 1,
  }]);
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: repo });
  const [e] = (await get(app)).body.events;
  assert.equal(e.eventType, 'future.invention');
  assert.equal(e.typeLabel, null, 'unknown means null, not a wrong guess');
});

test('maxSeverity filters syslog-numerically — lower is worse', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  const crit = await get(app, '?maxSeverity=3');
  assert.deepEqual(crit.body.events.map((e) => e.eventType), ['link.down']);

  const warnAndAbove = await get(app, '?maxSeverity=4');
  assert.equal(warnAndAbove.body.events.length, 2);
});

test('the severity chips count what the filter is hiding', async () => {
  // A chip is only useful while it counts the rows it is currently hiding, so
  // the counts ignore the severity filter itself.
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  const { body } = await get(app, '?maxSeverity=3');
  assert.equal(body.events.length, 1);
  assert.deepEqual(body.counts.map((c) => c.severity), [2, 4, 5]);
  assert.equal(body.counts.find((c) => c.severity === 4).occurrences, 3, 'folded repeats are counted');
});

test('filters narrow by device, type, transport and free text', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });

  assert.equal((await get(app, '?deviceId=4')).body.events.length, 2);
  assert.equal((await get(app, '?eventType=link.down')).body.events.length, 1);
  assert.equal((await get(app, '?transport=syslog')).body.events.length, 3);
  assert.equal((await get(app, '?transport=trap')).body.events.length, 0, 'no traps yet — stage 03');
  assert.equal((await get(app, '?q=FULL%20to%20DOWN')).body.events.length, 1);
  assert.equal((await get(app, '?q=Gi0%2F24')).body.events.length, 1, 'the interface is searchable');
});

test('hasMore says whether to offer another page', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  assert.equal((await get(app, '?limit=2')).body.hasMore, true);
  assert.equal((await get(app, '?limit=100')).body.hasMore, false);
});

test('a name lookup that fails costs the names, never the log', async () => {
  const app = makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: throwingAsync('inventory down'),
      findById: async () => ({ id: 4, hostname: 'x' }),
    }),
    deviceEventsRepo: await seeded(),
  });
  const res = await get(app);
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 3);
  assert.equal(res.body.events[0].deviceName, null);
});

// ------------------------------------------------------------------ catalog
test('GET /api/device-events/catalog serves the vocabulary the filters use', async () => {
  // Served rather than hardcoded in the dashboard so the filter list and the
  // stored data have exactly one definition.
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  const res = await request(app).get('/api/device-events/catalog').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.severities.length, 8);
  assert.deepEqual(res.body.severities[0], { value: 0, name: 'emerg' });
  assert.deepEqual(res.body.severities[7], { value: 7, name: 'debug' });
  const types = res.body.groups.flatMap((g) => g.types.map((t) => t.type));
  assert.ok(types.includes('link.down'));
  assert.ok(types.includes('syslog.raw'));
});

test('the catalog needs a token too', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: await seeded() });
  assert.equal((await request(app).get('/api/device-events/catalog')).status, 401);
});

// -------------------------------------------------- the server's vocabulary
test('the catalogue agrees with the agent about the severity bands', () => {
  const { severityBand, SEVERITY_NAMES, describeEventType } = require('../src/devices/deviceEventCatalog');
  // Eight syslog levels narrow to the three the rest of the server speaks, and
  // the narrowing lives in exactly one place.
  assert.equal(SEVERITY_NAMES.length, 8);
  assert.deepEqual([0, 1, 2, 3].map(severityBand), ['CRIT', 'CRIT', 'CRIT', 'CRIT']);
  assert.equal(severityBand(4), 'WARN');
  assert.deepEqual([5, 6, 7].map(severityBand), ['INFO', 'INFO', 'INFO']);
  // Junk never becomes a severity nobody measured.
  for (const bad of [null, undefined, 'crit', {}, NaN]) assert.equal(severityBand(bad), 'INFO');
  assert.equal(describeEventType('nope.nope'), null);
});
