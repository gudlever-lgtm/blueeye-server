'use strict';

// POST /agents/results carries the sFlow snapshot's `sflowCounters` into the
// sFlow counter ingest — best-effort, after the results are stored, and
// optional on the wire (older agents send none).

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentTokensRepo, makeSnmpDevicesRepo, makeDeviceInterfacesRepo, makeCounterSamplesRepo,
  makeSflowExportersRepo,
} = require('../test-support/fakes');
const { createSflowCounterIngest, IF_FIELDS } = require('../src/devices/sflowCounterIngest');

const agentTok = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
const COUNTERS = [{ agent: '10.14.0.2', ifIndex: 3, at: Date.now(), direction: 1, status: 3, if: IF_FIELDS.map(() => 1) }];

function spyIngest(impl) {
  const calls = [];
  return {
    calls,
    processResults: async (agentId, results) => {
      calls.push({ agentId, results });
      return impl ? impl(agentId, results) : null;
    },
  };
}

test('the results route hands every result to the sFlow counter ingest with the agent id', async () => {
  const sflowCounterIngest = spyIngest();
  const app = makeApp({ agentTokensRepo: agentTok(), sflowCounterIngest });
  const res = await request(app).post('/agents/results').set('Authorization', 'Bearer t')
    .send({ results: [{ traffic: { source: 'sflow', flows: [], sflowCounters: COUNTERS } }] });
  assert.equal(res.status, 201);
  assert.equal(sflowCounterIngest.calls.length, 1);
  assert.equal(sflowCounterIngest.calls[0].agentId, 9);
  assert.deepEqual(sflowCounterIngest.calls[0].results[0].traffic.sflowCounters, COUNTERS);
});

test('a failing sFlow counter ingest never costs the report (still 201)', async () => {
  const sflowCounterIngest = spyIngest(() => { throw new Error('boom'); });
  const app = makeApp({ agentTokensRepo: agentTok(), sflowCounterIngest });
  const res = await request(app).post('/agents/results').set('Authorization', 'Bearer t')
    .send({ results: [{ traffic: { sflowCounters: COUNTERS } }] });
  assert.equal(res.status, 201);
});

test('no token is 401 and an invalid body is 400 — the ingest is never reached', async () => {
  const sflowCounterIngest = spyIngest();
  const app = makeApp({ agentTokensRepo: agentTok(), sflowCounterIngest });
  const noAuth = await request(app).post('/agents/results').send({ results: [{ traffic: { sflowCounters: COUNTERS } }] });
  assert.equal(noAuth.status, 401);
  const bad = await request(app).post('/agents/results').set('Authorization', 'Bearer t').send({ results: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(sflowCounterIngest.calls.length, 0);
});

test('end to end: a registered switch gets a counter sample, an unknown exporter is recorded', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ host: '10.14.0.2', collect: ['if'] });
  const counterSamplesRepo = makeCounterSamplesRepo();
  const sflowExportersRepo = makeSflowExportersRepo();
  const sflowCounterIngest = createSflowCounterIngest({
    snmpDevicesRepo, deviceInterfacesRepo: makeDeviceInterfacesRepo(), counterSamplesRepo, sflowExportersRepo,
  });
  const app = makeApp({ agentTokensRepo: agentTok(), sflowCounterIngest });
  const res = await request(app).post('/agents/results').set('Authorization', 'Bearer t')
    .send({ results: [{ traffic: { sflowCounters: [...COUNTERS, { ...COUNTERS[0], agent: '10.99.0.1' }] } }] });
  assert.equal(res.status, 201);
  assert.equal(counterSamplesRepo.rows.length, 1);
  assert.deepEqual(sflowExportersRepo.rows.map((r) => [r.agentId, r.address, r.deviceId == null]).sort(),
    [[9, '10.14.0.2', false], [9, '10.99.0.1', true]]);
});

// ------------------------------------------------ what the results row stores
// sflowCounters (up to ~24 KB) and sflowExporters already land in their own
// tables; the results row — and its TSDB mirror — store the report without
// them, while every pipeline still gets the report as the agent sent it.
test('the results row and its TSDB mirror omit sflowCounters/sflowExporters; every pipeline still reads them', async () => {
  const stored = [];
  const mirrored = [];
  const seenBy = {};
  const spy = (name) => ({ processResults: async (_id, results) => { seenBy[name] = results; return null; } });
  const sflowCounterIngest = spyIngest();
  const app = makeApp({
    agentTokensRepo: agentTok(),
    sflowCounterIngest,
    resultsRepo: { createMany: async (_id, rows) => { stored.push(...rows); return rows.length; } },
    resultsTsdbRepo: { createMany: async (_id, rows) => { mirrored.push(...rows); return rows.length; } },
    analysisPipeline: spy('analysis'),
    flowPipeline: spy('flows'),
    interfaceStateService: spy('interfaceState'),
  });
  const traffic = {
    source: 'sflow', flows: [{ srcIp: '10.0.0.5', dstIp: '1.1.1.1', bytes: 10 }],
    sflowCounters: COUNTERS, sflowExporters: ['10.14.0.2', '10.14.0.9'],
  };
  const res = await request(app).post('/agents/results').set('Authorization', 'Bearer t')
    .send({ results: [{ type: 'auto-report', traffic }, { system: { cpu: 3 } }] });
  assert.equal(res.status, 201);
  assert.equal(res.body.inserted, 2);

  assert.equal(stored.length, 2);
  assert.equal('sflowCounters' in stored[0].traffic, false, 'no raw counters in the results row');
  assert.equal('sflowExporters' in stored[0].traffic, false);
  assert.deepEqual(stored[0].traffic.flows, traffic.flows, 'the rest of the snapshot is kept');
  assert.equal(stored[0].traffic.source, 'sflow');
  assert.deepEqual(stored[1], { system: { cpu: 3 } }, 'a result without sFlow detail is stored as sent');
  assert.deepEqual(mirrored, stored, 'the TSDB mirror gets the same stripped payload');

  // The pipelines read the report as the agent sent it.
  assert.deepEqual(sflowCounterIngest.calls[0].results[0].traffic.sflowCounters, COUNTERS);
  assert.deepEqual(sflowCounterIngest.calls[0].results[0].traffic.sflowExporters, ['10.14.0.2', '10.14.0.9']);
  for (const name of ['analysis', 'flows', 'interfaceState']) {
    assert.deepEqual(seenBy[name][0].traffic.flows, traffic.flows, `${name} still gets the flows`);
    assert.deepEqual(seenBy[name][0].traffic.sflowCounters, COUNTERS, `${name} gets the report unmodified`);
  }
});

test('withoutSflowDetail copies, never mutates, and handles the payload-wrapped shape', () => {
  const { withoutSflowDetail } = require('../src/devices/sflowCounterIngest');
  const plain = { traffic: { sflowCounters: COUNTERS, sflowExporters: ['10.0.0.1'], flows: [] } };
  const wrapped = { payload: { traffic: { sflowCounters: COUNTERS, bytesIn: 5 } } };
  const none = { traffic: { flows: [] } };
  const [a, b, c, d] = withoutSflowDetail([plain, wrapped, none, null]);
  assert.deepEqual(a, { traffic: { flows: [] } });
  assert.deepEqual(b, { payload: { traffic: { bytesIn: 5 } } });
  assert.equal(c, none, 'nothing to strip: the very same object');
  assert.equal(d, null);
  assert.deepEqual(plain.traffic.sflowCounters, COUNTERS, 'the original is untouched');
  assert.deepEqual(wrapped.payload.traffic.sflowCounters, COUNTERS);
});

// ------------------------------------------- exporters heard only in flows
test('traffic.sflowExporters: a flow-only exporter is recorded; junk is dropped, the report still 201', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  const sw = await snmpDevicesRepo.create({ host: '10.14.0.2', collect: ['if'] });
  const counterSamplesRepo = makeCounterSamplesRepo();
  const sflowExportersRepo = makeSflowExportersRepo();
  const sflowCounterIngest = createSflowCounterIngest({
    snmpDevicesRepo, deviceInterfacesRepo: makeDeviceInterfacesRepo(), counterSamplesRepo, sflowExportersRepo,
  });
  const app = makeApp({ agentTokensRepo: agentTok(), sflowCounterIngest });

  // First report: counters from the switch (1 port), flows from two more.
  const res = await request(app).post('/agents/results').set('Authorization', 'Bearer t')
    .send({ results: [{ traffic: {
      sflowCounters: COUNTERS,
      sflowExporters: ['10.14.0.2', '10.99.0.7', '2001:DB8::7', 'not-an-ip', 42, null, 'a'.repeat(300)],
    } }] });
  assert.equal(res.status, 201);
  const byAddr = () => Object.fromEntries(sflowExportersRepo.rows.map((r) => [r.address, r]));
  assert.deepEqual(Object.keys(byAddr()).sort(), ['10.14.0.2', '10.99.0.7', '2001:db8::7']);
  assert.equal(byAddr()['10.14.0.2'].deviceId, sw.id);
  assert.equal(byAddr()['10.14.0.2'].interfaces, 1);
  assert.equal(byAddr()['10.99.0.7'].deviceId, null, 'unregistered → a coverage gap');
  assert.equal(byAddr()['10.99.0.7'].interfaces, 0);

  // Second report: the switch heard in flows only — its port count is kept.
  const again = await request(app).post('/agents/results').set('Authorization', 'Bearer t')
    .send({ results: [{ traffic: { sflowExporters: ['10.14.0.2'] } }] });
  assert.equal(again.status, 201);
  assert.equal(byAddr()['10.14.0.2'].interfaces, 1, 'a flow-only sighting never zeroes the counted ports');
});

test('traffic.sflowExporters alone (no counters) reaches the ingest; an older agent without it is unchanged', async () => {
  const sflowExportersRepo = makeSflowExportersRepo();
  const ingest = createSflowCounterIngest({
    snmpDevicesRepo: makeSnmpDevicesRepo(), deviceInterfacesRepo: makeDeviceInterfacesRepo(),
    counterSamplesRepo: makeCounterSamplesRepo(), sflowExportersRepo,
  });
  const out = await ingest.processResults(9, [{ traffic: { sflowExporters: ['10.50.0.1'] } }]);
  assert.equal(out.flowOnly, 1);
  assert.equal(out.samples, 0);
  assert.deepEqual(sflowExportersRepo.rows.map((r) => [r.agentId, r.address, r.deviceId]), [[9, '10.50.0.1', null]]);
  assert.equal(await ingest.processResults(9, [{ traffic: { flows: [] } }]), null, 'nothing sFlow: nothing done');
  assert.equal(await ingest.processResults(9, [{ traffic: { sflowExporters: 'x' } }]), null, 'not an array: ignored');
});

test('traffic.sflowExporters is bounded to 256 addresses', async () => {
  const { normaliseExporters, MAX_EXPORTERS } = require('../src/devices/sflowCounterIngest');
  assert.equal(MAX_EXPORTERS, 256);
  const many = Array.from({ length: 400 }, (_, i) => `10.1.${i >> 8}.${i & 255}`);
  assert.equal(normaliseExporters(many).length, 256);
  assert.deepEqual(normaliseExporters(['10.0.0.1', '10.0.0.1', ' 10.0.0.2 ', 'host.example']), ['10.0.0.1', '10.0.0.2']);
  const sflowExportersRepo = makeSflowExportersRepo();
  const ingest = createSflowCounterIngest({
    snmpDevicesRepo: makeSnmpDevicesRepo(), deviceInterfacesRepo: makeDeviceInterfacesRepo(),
    counterSamplesRepo: makeCounterSamplesRepo(), sflowExportersRepo,
  });
  await ingest.processResults(9, [{ traffic: { sflowExporters: many } }, { traffic: { sflowExporters: ['10.200.0.1'] } }]);
  assert.equal(sflowExportersRepo.rows.length, 256);
});
