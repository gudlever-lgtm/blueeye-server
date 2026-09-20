'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// The ingest seam: POST /agents/me/device-events.
//
// What is actually being tested here is the two decisions the ingest makes that
// nothing else in the request path makes for it:
//
//   1. WHO SENT IT — a source IP resolved to a device through the agent
//      inventory, then the ARP table, then NULL. The third case is the one
//      worth protecting: a row from an unknown sender must be STORED, because
//      an incomplete inventory is exactly the situation an outage produces.
//   2. HOW IT FOLDS — a bucketed dedup key, so a device logging the same line
//      three hundred times in a minute becomes one row per window, and two
//      windows stay two rows.
//
// The agent is authenticated; its INPUT is not trusted. The malformed-row and
// bound cases live in the validation gate suite; what is checked here is that
// a bad row costs only itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeArpEntriesRepo,
  makeDeviceEventsRepo,
  throwingAsync,
} = require('../test-support/fakes');

const { createDeviceEventIngest, buildDedupKey } = require('../src/devices/deviceEventIngest');

// An agent token that maps to agent_id 9 — the agent that RECEIVES the syslog.
const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

// A fleet where agent 4 is a switch the server polls over SNMP at 10.14.0.11,
// and agent 9 is the host running the collector.
const fleet = () => makeAgentsRepo({
  findAll: async () => ([
    { id: 4, hostname: 'sw-core-1', monitor_config: { source: 'snmp', snmp: { host: '10.14.0.11' } }, capabilities: null },
    { id: 9, hostname: 'be-aarhus-01', monitor_config: { source: 'proc' }, capabilities: { ips: ['10.14.0.50'] } },
  ]),
  findById: async (id) => ([4, 9].includes(Number(id)) ? { id: Number(id), hostname: `agent-${id}` } : null),
});

const EVENT = (over = {}) => ({
  sourceIp: '10.14.0.11',
  receivedAt: '2026-09-20T09:41:12.418Z',
  deviceTime: '2026-09-20T09:41:09.418Z',
  transport: 'syslog',
  facility: 23,
  severity: 2,
  eventType: 'link.down',
  host: 'sw-core-1',
  tag: '%LINK-3-UPDOWN',
  ifname: 'GigabitEthernet0/1',
  summary: 'Interface GigabitEthernet0/1, changed state to down',
  raw: '<186>Sep 20 09:41:09 sw-core-1 %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down',
  occurrences: 1,
  ...over,
});

const post = (app, events) => request(app)
  .post('/agents/me/device-events')
  .set('Authorization', 'Bearer agent-tok')
  .send({ events });

// ------------------------------------------------------------------ auth
test('POST /agents/me/device-events requires an agent token', async () => {
  const app = makeApp({ agentTokensRepo: agentToken() });
  assert.equal((await request(app).post('/agents/me/device-events').send({ events: [EVENT()] })).status, 401);
});

test('a rejected agent token is 401, not a silent accept', async () => {
  const app = makeApp({ agentTokensRepo: makeAgentTokensRepo({ findActiveByHash: async () => null }) });
  const res = await request(app)
    .post('/agents/me/device-events')
    .set('Authorization', 'Bearer nope')
    .send({ events: [EVENT()] });
  assert.equal(res.status, 401);
});

// ------------------------------------------------------------------ 400
test('a body that is not a batch is 400', async () => {
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken() });
  for (const body of [{}, { events: 'lots' }, { events: { a: 1 } }]) {
    const res = await request(app)
      .post('/agents/me/device-events')
      .set('Authorization', 'Bearer agent-tok')
      .send(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.ok(res.body.details.events);
  }
});

test('an over-long batch is refused whole', async () => {
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken() });
  const res = await post(app, new Array(1001).fill(EVENT()));
  assert.equal(res.status, 400);
});

// ------------------------------------------------------------------ 503
test('no ingest configured answers 503, not a 202 into nowhere', async () => {
  // Answering "accepted" to a write that went nowhere is the one failure mode
  // an operator cannot diagnose from the outside.
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventIngest: null });
  assert.equal((await post(app, [EVENT()])).status, 503);
});

// ------------------------------------------------------------------ 500
test('a repository failure surfaces as 500, never a false 202', async () => {
  const app = makeApp({
    agentsRepo: fleet(),
    agentTokensRepo: agentToken(),
    deviceEventsRepo: makeDeviceEventsRepo({ createMany: throwingAsync('device_events down') }),
  });
  assert.equal((await post(app, [EVENT()])).status, 500);
});

// ------------------------------------------------------ sender resolution
test('a sender that matches an SNMP monitor target resolves to that device', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventsRepo });

  const res = await post(app, [EVENT()]);
  assert.equal(res.status, 202);
  assert.equal(res.body.inserted, 1);
  assert.equal(res.body.resolved, 1);
  assert.equal(res.body.unresolved, 0);

  const [row] = deviceEventsRepo.rows;
  assert.equal(row.device_id, 4, 'resolved to sw-core-1');
  assert.equal(row.agent_id, 9, 'received by be-aarhus-01');
  assert.equal(row.event_type, 'link.down');
  assert.equal(row.ifname, 'GigabitEthernet0/1');
  assert.equal(row.clock_skew_ms, 3000, 'the device clock is three seconds behind');
});

test('a sender that matches an agent-reported IP resolves to that agent', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventsRepo });
  await post(app, [EVENT({ sourceIp: '10.14.0.50' })]);
  assert.equal(deviceEventsRepo.rows[0].device_id, 9);
});

test('an unknown sender falls back to the ARP table', async () => {
  const arpEntriesRepo = makeArpEntriesRepo();
  await arpEntriesRepo.upsertMany(4, [{ ip: '10.14.0.77', mac: '00:11:22:33:44:55', interface: 'eth0' }]);
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventsRepo, arpEntriesRepo });

  const res = await post(app, [EVENT({ sourceIp: '10.14.0.77' })]);
  assert.equal(res.body.resolved, 1);
  assert.equal(deviceEventsRepo.rows[0].device_id, 4);
});

test('a sender nobody can resolve is STORED, not dropped', async () => {
  // This is the case worth protecting. The one message that explains an outage
  // often comes from the device nobody had got round to inventorying — and an
  // outage is exactly when the inventory is incomplete.
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventsRepo });

  const res = await post(app, [EVENT({ sourceIp: '192.0.2.99' })]);
  assert.equal(res.status, 202);
  assert.equal(res.body.inserted, 1);
  assert.equal(res.body.unresolved, 1);
  assert.equal(deviceEventsRepo.rows.length, 1);
  assert.equal(deviceEventsRepo.rows[0].device_id, null);
  assert.equal(deviceEventsRepo.rows[0].source_ip, '192.0.2.99', 'the address survives');
});

test('a failing ARP lookup does not fail the batch', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({
    agentsRepo: fleet(),
    agentTokensRepo: agentToken(),
    deviceEventsRepo,
    arpEntriesRepo: makeArpEntriesRepo({ findByIp: throwingAsync('arp table unavailable') }),
  });
  const res = await post(app, [EVENT({ sourceIp: '192.0.2.99' })]);
  assert.equal(res.status, 202);
  assert.equal(res.body.unresolved, 1);
});

test('one malformed row costs only itself', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventsRepo });

  const res = await post(app, [EVENT(), { nonsense: true }, EVENT({ summary: 'another line' })]);
  assert.equal(res.status, 202);
  assert.equal(res.body.skipped, 1);
  assert.equal(deviceEventsRepo.rows.length, 2, 'the other two were kept');
});

test('an empty batch is accepted and stores nothing', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventsRepo });
  const res = await post(app, []);
  assert.equal(res.status, 202);
  assert.equal(res.body.inserted, 0);
  assert.equal(deviceEventsRepo.rows.length, 0);
});

// ------------------------------------------------------------------ folding
test('the same event inside one window folds onto one row', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventsRepo });

  await post(app, [EVENT()]);
  const res = await post(app, [EVENT({ receivedAt: '2026-09-20T09:42:00.000Z', deviceTime: null })]);

  assert.equal(res.body.folded, 1);
  assert.equal(res.body.inserted, 0);
  assert.equal(deviceEventsRepo.rows.length, 1);
  assert.equal(deviceEventsRepo.rows[0].occurrences, 2);
  const [stored] = await deviceEventsRepo.listBetween({ limit: 10 });
  assert.equal(stored.receivedAt, '2026-09-20T09:42:00.000Z', 'the row stays current');
});

test('the same event in a LATER window is a second row', async () => {
  // Bounded folding is the whole point: a rate that changes over time must stay
  // readable as a sequence rather than collapsing into one eternal row.
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventsRepo });

  await post(app, [EVENT({ receivedAt: '2026-09-20T09:41:00.000Z' })]);
  await post(app, [EVENT({ receivedAt: '2026-09-20T10:15:00.000Z' })]);
  assert.equal(deviceEventsRepo.rows.length, 2);
});

test('different interfaces on one device do not fold together', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventsRepo });
  await post(app, [
    EVENT({ ifname: 'Gi0/1', summary: 'Interface Gi0/1, changed state to down' }),
    EVENT({ ifname: 'Gi0/2', summary: 'Interface Gi0/2, changed state to down' }),
  ]);
  assert.equal(deviceEventsRepo.rows.length, 2);
});

test('the same message from two unresolved senders does not fold together', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const app = makeApp({ agentsRepo: fleet(), agentTokensRepo: agentToken(), deviceEventsRepo });
  await post(app, [
    EVENT({ sourceIp: '192.0.2.1' }),
    EVENT({ sourceIp: '192.0.2.2' }),
  ]);
  assert.equal(deviceEventsRepo.rows.length, 2, 'the IP stands in for the identity');
});

// ------------------------------------------------------------ the key itself
test('the dedup key is bounded, bucketed and free of message text', () => {
  const e = {
    sourceIp: '10.14.0.11',
    receivedAt: '2026-09-20T09:41:12.418Z',
    transport: 'syslog',
    eventType: 'link.down',
    ifname: 'Gi0/1',
    summary: 'password hunter2 in a line the masking somehow missed',
  };
  const key = buildDedupKey(e, 4);
  assert.ok(key.length <= 160, 'fits the column');
  assert.ok(key.startsWith('d4|syslog|link.down|'));
  assert.ok(!key.includes('hunter2'), 'the message is hashed, never carried into an index');
  assert.ok(!key.includes(' '), 'no message text at all');

  // Same five-minute bucket → same key. Next bucket → different key.
  assert.equal(buildDedupKey({ ...e, receivedAt: '2026-09-20T09:44:59.000Z' }, 4), key);
  assert.notEqual(buildDedupKey({ ...e, receivedAt: '2026-09-20T09:46:00.000Z' }, 4), key);
  // A different device is a different key even for an identical line.
  assert.notEqual(buildDedupKey(e, 5), key);
});

// ------------------------------------------------------ resolver behaviour
test('the host resolver is cached, not rebuilt per batch', async () => {
  let calls = 0;
  const agentsRepo = makeAgentsRepo({
    findAll: async () => { calls += 1; return [{ id: 4, hostname: 'sw', monitor_config: { source: 'snmp', snmp: { host: '10.14.0.11' } } }]; },
  });
  const ingest = createDeviceEventIngest({
    deviceEventsRepo: makeDeviceEventsRepo(),
    agentsRepo,
  });
  await ingest.ingest(9, [EVENT()]);
  await ingest.ingest(9, [EVENT({ receivedAt: '2026-09-20T09:50:00.000Z' })]);
  assert.equal(calls, 1, 'one inventory read for two batches');

  ingest.invalidateResolver();
  await ingest.ingest(9, [EVENT({ receivedAt: '2026-09-20T10:00:00.000Z' })]);
  assert.equal(calls, 2, 'invalidation forces a rebuild');
});

test('an inventory read that fails does not lose the batch', async () => {
  const deviceEventsRepo = makeDeviceEventsRepo();
  const ingest = createDeviceEventIngest({
    deviceEventsRepo,
    agentsRepo: makeAgentsRepo({ findAll: throwingAsync('inventory unavailable') }),
  });
  const r = await ingest.ingest(9, [EVENT()]);
  assert.equal(r.inserted, 1);
  assert.equal(r.unresolved, 1, 'stored against no device rather than discarded');
});

test('resolving costs one ARP lookup per distinct address, not per row', async () => {
  // A switch mid-outage sends the same address hundreds of times.
  let lookups = 0;
  const arpEntriesRepo = makeArpEntriesRepo({
    findByIp: async () => { lookups += 1; return []; },
  });
  const ingest = createDeviceEventIngest({
    deviceEventsRepo: makeDeviceEventsRepo(),
    agentsRepo: makeAgentsRepo({ findAll: async () => [] }),
    arpEntriesRepo,
  });
  await ingest.ingest(9, new Array(50).fill(null).map((_, i) => EVENT({
    sourceIp: '192.0.2.5',
    summary: `line ${i}`,
  })));
  assert.equal(lookups, 1);
});
