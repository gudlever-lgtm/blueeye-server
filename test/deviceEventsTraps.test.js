'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Stage 03: SNMP traps on the rails stage 01 built.
//
// The claim this file checks is that the design held — a trap and a syslog line
// really are the same thing over a different socket, so traps needed NO new
// table, NO new route and NO new screen. If any of that were false, these tests
// would need something stage 01 did not already provide.
//
// What IS new: one vocabulary shared by two agent modules, a trap's honest
// absence of a device clock, and `link.admin_down` — somebody shut the port,
// which is a change rather than a symptom.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeDeviceEventsRepo,
  authHeader,
} = require('../test-support/fakes');

const { severityBand, describeEventType, KNOWN_EVENT_TYPES } = require('../src/devices/deviceEventCatalog');
const { classifyEvent, mapDeviceEvent, SOURCES } = require('../src/timeline/targetTimeline');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

const agentsRepo = () => makeAgentsRepo({
  findAll: async () => ([
    { id: 4, hostname: 'sw-core-1', display_name: 'Core switch', monitor_config: { source: 'snmp', snmp: { host: '10.14.0.11' } } },
    { id: 9, hostname: 'be-aarhus-01', capabilities: { ips: ['10.14.0.50'] } },
  ]),
  findById: async (id) => ([4, 9].includes(Number(id)) ? { id: Number(id), hostname: `agent-${id}` } : null),
});

// A trap as the agent's translator produces it — no device clock, a trap OID in
// `tag`, and the varbinds in `detail`.
//
// `receivedAt` is RELATIVE to now, not a fixed date: the device log's default
// window is the last two hours, so a hard-coded timestamp silently ages out of
// every read and the test starts failing by the clock rather than by the code.
const TRAP = (over = {}) => ({
  sourceIp: '10.14.0.11',
  receivedAt: new Date(Date.now() - 60_000).toISOString(),
  deviceTime: null,
  transport: 'trap',
  facility: null,
  severity: 2,
  eventType: 'link.down',
  host: null,
  tag: '1.3.6.1.6.3.1.1.5.3',
  ifname: 'GigabitEthernet0/1',
  summary: 'linkDown on GigabitEthernet0/1 — now down',
  raw: 'snmpTrapOID=1.3.6.1.6.3.1.1.5.3',
  detail: { trapOid: '1.3.6.1.6.3.1.1.5.3', upTimeTicks: 123456, varbinds: [{ oid: '1.3.6.1.2.1.2.2.1.1.1', value: '1' }] },
  occurrences: 1,
  ...over,
});

const post = (app, events) => request(app)
  .post('/agents/me/device-events')
  .set('Authorization', 'Bearer agent-tok')
  .send({ events });

const get = (app, qs = '', role = 'viewer') =>
  request(app).get(`/api/device-events${qs}`).set('Authorization', authHeader(role));

// ============================================ the rails carried it unchanged
test('a trap goes in through the SAME route stage 01 built', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), deviceEventsRepo });

  const res = await post(app, [TRAP()]);
  assert.equal(res.status, 202);
  assert.equal(res.body.inserted, 1);
  assert.equal(res.body.resolved, 1, 'and resolves to the switch like any other event');

  const [row] = deviceEventsRepo.rows;
  assert.equal(row.transport, 'trap');
  assert.equal(row.device_id, 4);
  assert.equal(row.event_type, 'link.down');
  assert.equal(row.tag, '1.3.6.1.6.3.1.1.5.3');
  assert.deepEqual(row.detail.varbinds, [{ oid: '1.3.6.1.2.1.2.2.1.1.1', value: '1' }]);
});

test('a trap carries no device clock, and that is stored as null rather than guessed', async () => {
  // sysUpTime is an uptime, not a date. Fabricating a timestamp would put a
  // made-up number in the column the clock-skew check reads.
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), deviceEventsRepo });
  await post(app, [TRAP()]);
  assert.equal(deviceEventsRepo.rows[0].device_time, null);
  assert.equal(deviceEventsRepo.rows[0].clock_skew_ms, null);
});

test('traps and syslog arrive in ONE batch and both store', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), deviceEventsRepo });

  const syslogRow = {
    ...TRAP(),
    transport: 'syslog',
    deviceTime: new Date(Date.now() - 63_000).toISOString(),
    facility: 23,
    tag: '%LINK-3-UPDOWN',
    summary: 'Interface GigabitEthernet0/1, changed state to down',
  };
  const res = await post(app, [TRAP(), syslogRow]);
  assert.equal(res.status, 202);
  assert.equal(res.body.inserted, 2);
  assert.deepEqual(deviceEventsRepo.rows.map((r) => r.transport).sort(), ['syslog', 'trap']);
});

test('a trap and the syslog line about the same event do NOT fold together', async () => {
  // They are two observations of one fault, a second apart, from two code paths
  // on the device. Folding them would hide that the trap arrived first — which
  // is the entire argument for collecting both.
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), deviceEventsRepo });
  await post(app, [
    TRAP(),
    { ...TRAP(), transport: 'syslog', summary: 'linkDown on GigabitEthernet0/1 — now down' },
  ]);
  assert.equal(deviceEventsRepo.rows.length, 2, 'transport is part of the dedup key');
});

test('the device log filters traps apart from syslog', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), deviceEventsRepo });
  await post(app, [TRAP(), { ...TRAP(), transport: 'syslog', summary: 'a log line' }]);

  assert.equal((await get(app, '?transport=trap')).body.events.length, 1);
  assert.equal((await get(app, '?transport=syslog')).body.events.length, 1);
  assert.equal((await get(app, '')).body.events.length, 2, 'and unfiltered shows both');
});

test('a trap is readable by a viewer, like any other device event', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), deviceEventsRepo });
  await post(app, [TRAP()]);
  const [e] = (await get(app)).body.events;
  assert.equal(e.transport, 'trap');
  assert.equal(e.deviceName, 'Core switch');
  assert.equal(e.severityName, 'crit');
  assert.equal(e.typeLabel, 'Link nede');
});

// ============================================================ the vocabulary
test('a trap-only event_type has a label, so the filter can offer it', async () => {
  // The catalogue is shared: types the trap translator produces and types the
  // syslog classifier produces land in the same list.
  const app = makeApp({ agentsRepo: agentsRepo(), deviceEventsRepo: makeDeviceEventsRepo() });
  const { body } = await request(app).get('/api/device-events/catalog').set('Authorization', authHeader('viewer'));
  const types = body.groups.flatMap((g) => g.types.map((t) => t.type));
  for (const trapOnly of ['link.admin_down', 'ups.alarm', 'sensor.threshold', 'poe.budget_exceeded', 'device.hardware_changed']) {
    assert.ok(types.includes(trapOnly), trapOnly);
  }
});

test('a trap type this server has not heard of is still stored and shown', async () => {
  // The agent ships both translators and may be newer. Refusing an unknown type
  // would mean an agent upgrade silently dropping what it just got better at.
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: agentsRepo(), agentTokensRepo: agentToken(), deviceEventsRepo });
  await post(app, [TRAP({ eventType: 'vendor.future_thing' })]);
  const [e] = (await get(app)).body.events;
  assert.equal(e.eventType, 'vendor.future_thing');
  assert.equal(e.typeLabel, null, 'unknown means null, never a wrong guess');
});

test('every catalogued type is a dotted identifier the validator accepts', () => {
  // A type the catalogue offers but the boundary rewrites to syslog.raw would
  // be a filter that can never match anything.
  const { EVENT_TYPE_RE } = require('../src/validation/deviceEventValidation');
  for (const type of KNOWN_EVENT_TYPES) assert.match(type, EVENT_TYPE_RE, type);
});

test('the catalogue grew with the trap types and stays deduped', () => {
  assert.ok(KNOWN_EVENT_TYPES.length >= 35, `only ${KNOWN_EVENT_TYPES.length}`);
  assert.equal(new Set(KNOWN_EVENT_TYPES).size, KNOWN_EVENT_TYPES.length);
  assert.equal(describeEventType('link.admin_down'), 'Port slukket administrativt');
});

// ======================================================= somebody vs something
test('an administratively-down port is a CHANGE, not a symptom', async () => {
  // Somebody shut this port. "What changed before this finding" should say so,
  // and it sends a technician somewhere entirely different from a port that
  // fell over on its own.
  assert.equal(classifyEvent({ source: SOURCES.DEVICE, type: 'link.admin_down' }), 'change');
  assert.equal(classifyEvent({ source: SOURCES.DEVICE, type: 'link.down' }), 'symptom');
});

test('a trap on the timeline reads in the same three severity bands', () => {
  // Eight syslog levels narrow to three, in one place, for both transports.
  const [event] = mapDeviceEvent(
    { receivedAt: '2026-09-20T09:41:11.000Z', eventType: 'link.down', severity: 2, summary: 'linkDown', ifname: 'Gi0/1', occurrences: 1, id: 7 },
    { severityBand },
  );
  assert.equal(event.source, 'device');
  assert.equal(event.severity, 'CRIT');
  assert.equal(event.summary, 'Gi0/1: linkDown');
  assert.equal(event.ref_id, 7);

  // An admin-down trap is notice-level, so it does not shout on the timeline.
  assert.equal(severityBand(5), 'INFO');
});

test('a folded trap says how many times, like a folded syslog line', () => {
  const [event] = mapDeviceEvent(
    { receivedAt: '2026-09-20T09:41:11.000Z', eventType: 'link.down', severity: 2, summary: 'linkDown', ifname: 'Gi0/1', occurrences: 40, id: 7 },
    { severityBand },
  );
  assert.match(event.summary, /\(x40\)/, 'a port that blipped and one that is flapping read differently');
});
