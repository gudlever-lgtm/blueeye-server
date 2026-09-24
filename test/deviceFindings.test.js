'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Trin 4: a finding can name a DEVICE and a PORT, and per-interface counters
// finally reach the detector.
//
// Two things were true before this and both were wrong:
//
//   * `findings.host_id` was always an agent. A switch port dropping frames
//     had nowhere to go, so the only options were to smuggle device+port into
//     a string (destroying every join to `agents`, silently) or to give
//     devices a second findings table (two places to look for "something is
//     wrong", which is what event_cases exists to prevent).
//   * extractSamples() emitted six metrics, all host-level. Per-interface
//     errors and discards were collected, stored, shown on a screen — and
//     never evaluated by anything.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { extractDeviceSamples, extractCycleSamples } = require('../src/analysis/deviceIngest');
const { createDetector } = require('../src/analysis/detector');
const { createAnalysisPipeline } = require('../src/analysis/pipeline');
const {
  makeApp, makeFindingStore, makeAgentsRepo, makeAgentTokensRepo,
  makeSnmpDevicesRepo, makeDeviceInterfacesRepo, makeCounterSamplesRepo,
  authHeader, throwingAsync,
} = require('../test-support/fakes');

const SAMPLE = (over = {}) => ({
  ts: '2026-09-20T12:01:00.000Z',
  deviceId: 4,
  interfaceId: 12,
  ifName: 'GigabitEthernet1/0/12',
  inUtilPct: 6.2,
  outUtilPct: 1.1,
  inErrPps: 0.4,
  outErrPps: 0,
  inDiscPps: 0,
  outDiscPps: 0,
  fcsPps: 0,
  inBcastPps: 3,
  discontinuity: null,
  ...over,
});

// ================================================== the extractor
test('a counter row becomes one sample per RATE, and none per raw counter', () => {
  // A counter is monotonically rising, so its median is meaningless and every
  // sample is an all-time high — a baseline over it would call steady traffic
  // an anomaly forever.
  const out = extractDeviceSamples(SAMPLE({ inOctets: 999_999_999 }), { hostId: '9' });
  const metrics = out.map((s) => s.metric);
  assert.ok(metrics.includes('if.12.in.errPps'));
  assert.ok(metrics.includes('if.12.in.utilPct'));
  assert.ok(!metrics.some((m) => m.includes('Octets')), 'no raw counter is baselined');
});

test('the metric name carries the PORT, so one bad port cannot raise the baseline for forty-eight', () => {
  // Baselines key on (hostId, metric, bucket). Without the id in the name,
  // every port on a switch would share one baseline.
  const a = extractDeviceSamples(SAMPLE({ interfaceId: 12 }), { hostId: '9' })[0];
  const b = extractDeviceSamples(SAMPLE({ interfaceId: 13 }), { hostId: '9' })[0];
  assert.equal(a.metric, 'if.12.in.utilPct');
  assert.equal(b.metric, 'if.13.in.utilPct');
});

test('the sample carries the device and the port, and the POLLING AGENT as hostId', () => {
  // hostId stays an agent so every per-agent read still finds these; the device
  // and port ride alongside (migration 110).
  const [s] = extractDeviceSamples(SAMPLE(), { hostId: '9' });
  assert.equal(s.hostId, '9');
  assert.equal(s.deviceId, 4);
  assert.equal(s.interfaceId, 12);
  assert.equal(s.labels.iface, 'GigabitEthernet1/0/12');
});

test('a row whose rates were VOIDED produces nothing', () => {
  // A reboot, a renumbering or a bad gap leaves raw counters and null rates on
  // purpose. Feeding a null through as 0 would teach the baseline that the port
  // went quiet, when what happened is that we could not measure it.
  for (const d of ['first', 'reboot', 'renumber', 'gap', 'wrap']) {
    assert.deepEqual(extractDeviceSamples(SAMPLE({ discontinuity: d }), { hostId: '9' }), [], d);
  }
});

test('a rate the device could not report is skipped, never zeroed', () => {
  const out = extractDeviceSamples(SAMPLE({ fcsPps: null, inErrPps: null }), { hostId: '9' });
  const metrics = out.map((s) => s.metric);
  assert.ok(!metrics.includes('if.12.fcs.pps'));
  assert.ok(!metrics.includes('if.12.in.errPps'));
  assert.ok(metrics.includes('if.12.in.utilPct'), 'the ones it DID report are unaffected');
});

test('a measured zero IS a sample — that is the point of the distinction', () => {
  const out = extractDeviceSamples(SAMPLE({ inErrPps: 0 }), { hostId: '9' });
  const s = out.find((x) => x.metric === 'if.12.in.errPps');
  assert.equal(s.value, 0);
});

test('a row with no usable port id produces nothing', () => {
  assert.deepEqual(extractDeviceSamples(SAMPLE({ interfaceId: null }), { hostId: '9' }), []);
  assert.deepEqual(extractDeviceSamples(null, { hostId: '9' }), []);
});

test('a whole cycle extracts in one call', () => {
  const out = extractCycleSamples(
    [SAMPLE({ interfaceId: 1 }), SAMPLE({ interfaceId: 2 }), SAMPLE({ interfaceId: 3, discontinuity: 'reboot' })],
    { hostId: '9' },
  );
  const ports = new Set(out.map((s) => s.interfaceId));
  assert.deepEqual([...ports].sort(), [1, 2]);
});

// ============================================== through the detector
// A seeded baseline may carry `flatAt`: the value its trailing samples all
// share. This stub used to answer isFlat() with a constant `false`, which is
// never true of a port that has not discarded once — its history IS a flat run
// of zeros — and so hid the fact that the detector called the first real
// discard a FLATLINE (and every healthy zero one too). It now mirrors the real
// store: flat only when the value being judged continues the run.
function fakeBaselines() {
  const store = new Map();
  return {
    bucket: () => 'b',
    get: (hostId, metric) => store.get(`${hostId}|${metric}`) || null,
    update: () => {},
    isFlat: (hostId, metric, value) => {
      const b = store.get(`${hostId}|${metric}`);
      return Boolean(b && b.flatAt !== undefined && (value === undefined || value === b.flatAt));
    },
    seed: (hostId, metric, v) => store.set(`${hostId}|${metric}`, v),
  };
}

test('a port that starts discarding raises a finding that names the PORT', async () => {
  const baselines = fakeBaselines();
  // A port that has never discarded: a tight baseline around zero.
  baselines.seed('9', 'if.12.in.discPps', { n: 100, median: 0, mad: 0.01, sigma: 0.015, flatAt: 0 });
  const detector = createDetector({ baselines, config: { critSigma: 6, warnSigma: 3, baselineDays: 7, minSamples: 10 } });

  const [sample] = extractDeviceSamples(SAMPLE({ inDiscPps: 4, inUtilPct: null, outUtilPct: null, inErrPps: null, outErrPps: null, outDiscPps: null, fcsPps: null, inBcastPps: null }), { hostId: '9' });
  const finding = detector.evaluate(sample);

  assert.ok(finding, 'four discards a second against a baseline of none is a fault');
  assert.equal(finding.severity, 'CRIT');
  assert.equal(finding.hostId, '9');
  assert.equal(finding.deviceId, 4, 'the finding names the switch');
  assert.equal(finding.interfaceId, 12, 'and the port');
});

// The same scenario on the REAL baseline store and detector, with nothing
// stubbed: the audit reproduction (250 zeros on an FCS rate, then a 5).
function fcsRun(metric) {
  const { createBaselineStore } = require('../src/analysis/baselines');
  const { loadConfig } = require('../src/analysis/config');
  const baselines = createBaselineStore({});
  const detector = createDetector({ baselines, config: loadConfig({}) }); // minSamples 200
  const t0 = Date.parse('2026-01-01T03:00:00Z'); // one hour bucket throughout
  const at = (i) => new Date(t0 + i * 1000);
  const zeros = [];
  for (let i = 1; i <= 250; i += 1) {
    zeros.push(detector.evaluate({ hostId: '9', deviceId: 4, interfaceId: 3, metric, value: 0, ts: at(i), labels: {} }));
  }
  const first = detector.evaluate({ hostId: '9', deviceId: 4, interfaceId: 3, metric, value: 5, ts: at(251), labels: {} });
  const second = detector.evaluate({ hostId: '9', deviceId: 4, interfaceId: 3, metric, value: 5, ts: at(252), labels: {} });
  return { zeros, first, second };
}

test('a healthy port reading 0 errors raises nothing — no FLATLINE on a zero counter (real store)', () => {
  const { zeros } = fcsRun('if.3.fcs.pps');
  assert.deepEqual(zeros.filter(Boolean), [], 'a constant 0 is the healthy state of an error rate, not a stalled sensor');
});

test('the FIRST real error on a zero counter is an ANOMALY, not a FLATLINE (real store)', () => {
  const { first, second } = fcsRun('if.3.fcs.pps');
  assert.ok(first, 'the first FCS error is reported on the sample it happens');
  assert.equal(first.kind, 'ANOMALY');
  assert.equal(first.severity, 'WARN');
  assert.equal(first.interfaceId, 3);
  // A zero-MAD baseline has no scale: no fabricated sigma, no Infinity/NaN.
  assert.equal(first.deviation, null);
  assert.match(first.explanation, /if\.3\.fcs\.pps at 5 left a constant/);
  // Once the window holds a non-zero value there is a scale again.
  assert.equal(second.kind, 'ANOMALY');
  assert.equal(second.severity, 'CRIT');
  assert.ok(Number.isFinite(second.deviation) && second.deviation > 0);
});

test('every device-port rate is flatline-exempt; agent metrics are not', () => {
  const { isDevicePortMetric } = require('../src/analysis/detector');
  for (const m of ['in.errPps', 'out.errPps', 'in.discPps', 'out.discPps', 'fcs.pps', 'in.bcastPps', 'in.utilPct', 'out.utilPct']) {
    assert.equal(isDevicePortMetric(`if.12.${m}`), true, m);
  }
  for (const m of ['cpu', 'mem', 'load1', 'if.x.fcs.pps', 'if.3.fcs.pps.extra', 'xif.3.fcs.pps']) {
    assert.equal(isDevicePortMetric(m), false, m);
  }
});

test('a finding about an AGENT still has neither, exactly as before', () => {
  const baselines = fakeBaselines();
  baselines.seed('9', 'cpu', { n: 100, median: 10, mad: 1, sigma: 1.5 });
  const detector = createDetector({ baselines, config: { critSigma: 6, warnSigma: 3, baselineDays: 7, minSamples: 10 } });
  const finding = detector.evaluate({ hostId: '9', metric: 'cpu', value: 95, ts: new Date(), labels: {} });
  assert.ok(finding);
  assert.equal(finding.deviceId, null);
  assert.equal(finding.interfaceId, null);
});

test('the device path runs the SAME pipeline as the agent path', async () => {
  // Grouped, correlated and alerted on exactly like a host finding — which is
  // the whole argument for extending `findings` rather than giving devices a
  // second table.
  const baselines = fakeBaselines();
  baselines.seed('9', 'if.12.in.errPps', { n: 100, median: 0, mad: 0.01, sigma: 0.015, flatAt: 0 });
  const findingStore = makeFindingStore();
  const assigned = [];
  const pipeline = createAnalysisPipeline({
    detector: createDetector({ baselines, config: { critSigma: 6, warnSigma: 3, baselineDays: 7, minSamples: 10 } }),
    findingStore,
    config: { analysisEnabled: true },
    eventCaseService: { assignFinding: async (f) => assigned.push(f.id) },
  });

  const produced = await pipeline.processDeviceSamples('9', [SAMPLE({
    inErrPps: 9, inUtilPct: null, outUtilPct: null, inDiscPps: null,
    outDiscPps: null, outErrPps: null, fcsPps: null, inBcastPps: null,
  })]);

  assert.equal(produced.length, 1);
  assert.equal(findingStore.rows.length, 1);
  assert.equal(findingStore.rows[0].interfaceId, 12);
  assert.equal(assigned.length, 1, 'it went into an event case like any other finding');
});

test('with analysis switched off the device path produces nothing', async () => {
  const pipeline = createAnalysisPipeline({
    detector: createDetector({ baselines: fakeBaselines() }),
    findingStore: makeFindingStore(),
    config: { analysisEnabled: false },
  });
  assert.deepEqual(await pipeline.processDeviceSamples('9', [SAMPLE()]), []);
});

// ===================================================== through the API
const agentsRepo = () => makeAgentsRepo({
  findAll: async () => ([{ id: 9, hostname: 'be-aarhus-01' }]),
  findById: async (id) => (Number(id) === 9 ? { id: 9, hostname: 'be-aarhus-01' } : null),
});

test('findings can be filtered to a device and to a port', async () => {
  const findingStore = makeFindingStore();
  await findingStore.save({ hostId: '9', deviceId: 4, interfaceId: 12, metric: 'if.12.in.errPps', severity: 'CRIT', kind: 'ANOMALY', createdAt: new Date() });
  await findingStore.save({ hostId: '9', deviceId: 4, interfaceId: 13, metric: 'if.13.in.errPps', severity: 'WARN', kind: 'ANOMALY', createdAt: new Date() });
  await findingStore.save({ hostId: '9', deviceId: null, interfaceId: null, metric: 'cpu', severity: 'WARN', kind: 'ANOMALY', createdAt: new Date() });
  const app = makeApp({ agentsRepo: agentsRepo(), findingStore });

  const all = await request(app).get('/api/findings?hostId=9').set('Authorization', authHeader('viewer'));
  assert.equal(all.body.length, 3, 'the agent filter still finds the switch ones too');

  const device = await request(app).get('/api/findings?deviceId=4').set('Authorization', authHeader('viewer'));
  assert.equal(device.body.length, 2);

  const port = await request(app).get('/api/findings?interfaceId=12').set('Authorization', authHeader('viewer'));
  assert.equal(port.body.length, 1);
  assert.equal(port.body[0].metric, 'if.12.in.errPps');
});

test('a bad device filter is a 400, not a silent full list', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), findingStore: makeFindingStore() });
  for (const qs of ['deviceId=abc', 'deviceId=0', 'deviceId=-1', 'interfaceId=abc']) {
    const res = await request(app).get(`/api/findings?${qs}`).set('Authorization', authHeader('viewer'));
    assert.equal(res.status, 400, qs);
  }
});

test('a findings read that fails is a 500, never an empty device list', async () => {
  // An empty array here reads as "this switch has no findings", which is the
  // one answer a monitoring screen must never invent.
  const app = makeApp({
    agentsRepo: agentsRepo(),
    findingStore: makeFindingStore({ list: throwingAsync() }),
  });
  const res = await request(app).get('/api/findings?deviceId=4').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
  assert.ok(!Array.isArray(res.body), 'a failure must not be shaped like a result');
});

test('counters arriving through the ingest reach the detector', async () => {
  // End to end: an agent posts a counter cycle, and a port whose discards went
  // from none to four a second produces a finding that names the port.
  const baselines = fakeBaselines();
  const findingStore = makeFindingStore();
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11', collect: ['ifcounters'] });
  const deviceInterfacesRepo = makeDeviceInterfacesRepo();
  await deviceInterfacesRepo.upsertMany(1, [{ ifName: 'Gi0/1', ifIndex: 1, speedMbps: 1000 }]);
  const portId = deviceInterfacesRepo.rows[0].id;
  baselines.seed('9', `if.${portId}.in.discPps`, { n: 100, median: 0, mad: 0.01, sigma: 0.015 });

  const analysisPipeline = createAnalysisPipeline({
    detector: createDetector({ baselines, config: { critSigma: 6, warnSigma: 3, baselineDays: 7, minSamples: 10 } }),
    findingStore,
    config: { analysisEnabled: true },
  });

  const app = makeApp({
    agentsRepo: agentsRepo(),
    agentTokensRepo: makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) }),
    snmpDevicesRepo, deviceInterfacesRepo,
    counterSamplesRepo: makeCounterSamplesRepo(),
    analysisPipeline,
  });

  // sysUpTime ADVANCES with the wall clock between the two polls. It has to:
  // an uptime that did not move while sixty seconds passed is a device that
  // rebooted in between, and the ingest would rightly void the delta.
  const post = (readAt, ticks, over) => request(app)
    .post('/agents/me/snmp-counters')
    .set('Authorization', 'Bearer agent-tok')
    .send({ devices: [{ deviceId: 1, readAt, sysUpTimeTicks: ticks, hc: true, interfaces: [{ ifIndex: 1, ifName: 'Gi0/1', inOctets: 1_000_000, inDiscards: 0, ...over }] }] });

  // One `Date.now()` for both. Two calls are two readings of a clock that can
  // tick between them, which makes the interval 60.001 seconds and every rate
  // computed from it a hair off — the same intermittent failure this pattern
  // already caused in snmpCountersApi.test.js.
  const now = Date.now();
  const t0 = new Date(now - 120_000).toISOString();
  const t1 = new Date(now - 60_000).toISOString();
  await post(t0, 500_000, {});
  const res = await post(t1, 506_000, { inOctets: 1_750_000, inDiscards: 240 });

  assert.equal(res.status, 202);
  assert.equal(res.body.findings, 1, 'four discards a second reached the detector');
  assert.equal(findingStore.rows[0].interfaceId, portId);
  assert.equal(findingStore.rows[0].deviceId, 1);
  assert.equal(findingStore.rows[0].hostId, '9', 'the polling agent, so per-agent reads still find it');
});
