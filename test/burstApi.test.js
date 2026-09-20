'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Stage 04: burst mode — one target, once a second, for up to two minutes.
//
// Two things carry this feature, and both are tested here rather than assumed:
//
//   1. THE VERDICT. "6.3% loss, median 1.4 ms" is a row of figures; a
//      technician already knew something was wrong or they would not have run
//      a burst. Whether the loss is EVEN or CLUSTERED is the diagnostic value,
//      and the sentence that says which is the only part of the row worth
//      anything on its own.
//   2. OWNERSHIP. A result may only complete a run that was dispatched to THAT
//      agent, so one agent cannot write another's measurement.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeBurstRunsRepo,
  makeAgentCommander,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const { analyseBurst, clusterLosses, PATTERN } = require('../src/probes/burstAnalysis');
const { createBurstService } = require('../src/probes/burstService');

const agentsRepo = () => makeAgentsRepo({
  findById: async (id) => (Number(id) === 9 ? { id: 9, hostname: 'be-aarhus-01' } : null),
});

// A series of `n` samples with losses at the given indexes.
const series = (n, lostAt = [], rtt = 1.4) => Array.from({ length: n }, (_, i) => ({
  t: i,
  ok: !lostAt.includes(i),
  rttMs: lostAt.includes(i) ? null : rtt,
}));

const start = (app, body, role = 'operator') =>
  request(app).post('/api/burst').set('Authorization', authHeader(role)).send(body);

// =========================================================== the verdict
test('two bursts of loss read as PERIODIC, not congestion', () => {
  // The finding worth the run. Congestion and a recurring event are different
  // faults in different places, and a loss percentage alone cannot tell them
  // apart.
  const r = analyseBurst(series(38, [11, 12, 13, 27, 28]), { hz: 1 });
  assert.equal(r.pattern, PATTERN.CLUSTERED);
  assert.equal(r.lossClusters, 2);
  assert.match(r.explanation, /not congestion/);
  assert.deepEqual(r.clusters, [
    { start: 11, end: 13, size: 3 },
    { start: 27, end: 28, size: 2 },
  ]);
});

test('single losses at a REGULAR interval read as scheduled or cyclic', () => {
  const r = analyseBurst(series(60, [5, 17, 29, 41, 53]), { hz: 1 });
  assert.equal(r.pattern, PATTERN.CLUSTERED);
  assert.match(r.explanation, /regular 12s interval/);
});

test('single losses at IRREGULAR intervals read as an even, continuous fault', () => {
  // The distinction most easily got wrong: random 5% loss also produces a
  // median gap of twelve. Calling that "every 12 seconds" would send somebody
  // hunting for a scheduled job that does not exist — so the test is the
  // SPREAD of the gaps, not their size.
  const r = analyseBurst(series(60, [3, 9, 28, 31, 52]), { hz: 1 });
  assert.equal(r.pattern, PATTERN.EVEN);
  assert.match(r.explanation, /irregularly spaced/);
  assert.match(r.explanation, /congestion, a duplex mismatch or a bad cable/);
});

test('one burst of loss is one event, not a bad path', () => {
  const r = analyseBurst(series(60, [30, 31, 32]), { hz: 1 });
  assert.equal(r.pattern, PATTERN.CLUSTERED);
  assert.match(r.explanation, /single burst/);
});

test('loss at the very start is probably the measurement, not the path', () => {
  const r = analyseBurst(series(60, [0, 1, 2]), { hz: 1 });
  assert.equal(r.pattern, PATTERN.EDGE);
  assert.match(r.explanation, /re-run it around the fault/);
});

test('a clean burst says so plainly', () => {
  const r = analyseBurst(series(60), { hz: 1 });
  assert.equal(r.pattern, PATTERN.CLEAN);
  assert.equal(r.lossPct, 0);
  assert.match(r.explanation, /not this path dropping packets/);
});

test('total loss is unreachable, which is not the same as degraded', () => {
  const r = analyseBurst(series(30, [...Array(30).keys()]), { hz: 1 });
  assert.equal(r.pattern, PATTERN.TOTAL);
  assert.match(r.explanation, /unreachable, not degraded/);
});

test('too few samples refuses to claim a shape', () => {
  // Two losses in six samples is not a pattern, it is two losses.
  const r = analyseBurst(series(6, [2, 4]), { hz: 1 });
  assert.equal(r.pattern, PATTERN.INSUFFICIENT);
  assert.match(r.explanation, /run a longer burst/);
});

test('jitter uses MAD, so one outlier does not claim an unstable path', () => {
  // A single 400 ms spike in a 1.4 ms series would dominate a standard
  // deviation and report instability where there was one hiccup.
  const s = series(40);
  s[20] = { t: 20, ok: true, rttMs: 400 };
  const r = analyseBurst(s, { hz: 1 });
  assert.equal(r.medianRttMs, 1.4);
  assert.ok(r.jitterMs < 1, `jitter was ${r.jitterMs}`);
  // p95 excludes it too, by design: one sample in forty is inside the top 5%,
  // which is exactly the tail a p95 is meant to cut. The spike is not lost —
  // it is a visible point on the chart, where a person can judge whether one
  // 400 ms reply matters. What must not happen is a SUMMARY NUMBER claiming
  // the path is unstable on the strength of it.
  assert.equal(r.p95RttMs, 1.4);

  // Five spikes in forty is 12.5% and does reach the tail, which is the point
  // at which it stops being an outlier and starts being the path.
  const many = series(40);
  for (const i of [5, 11, 19, 26, 33]) many[i] = { t: i, ok: true, rttMs: 400 };
  assert.equal(analyseBurst(many, { hz: 1 }).p95RttMs, 400);
});

test('the cluster gap is what makes consecutive losses one event', () => {
  assert.deepEqual(clusterLosses([1, 2, 3]).length, 1);
  assert.deepEqual(clusterLosses([1, 3, 5]).length, 1, 'a one-sample gap is still the same burst');
  assert.deepEqual(clusterLosses([1, 10, 20]).length, 3);
  assert.deepEqual(clusterLosses([]), []);
});

test('the analysis survives junk without throwing', () => {
  for (const bad of [null, undefined, 'x', 42, [null, 'x', {}], []]) {
    const r = analyseBurst(bad, { hz: 1 });
    assert.equal(typeof r.explanation, 'string');
    assert.ok(Number.isInteger(r.sampleCount));
  }
});

// =========================================================== starting one
test('POST /api/burst is 401 without a token and 403 for a viewer', async () => {
  // Starting a burst makes an agent emit traffic at a rate nothing else here
  // does. It is not admin, though: the person in front of the fault at 02:00
  // is usually not one, and a tool they cannot reach does not exist.
  const app = makeApp({ agentsRepo: agentsRepo(), agentCommander: makeAgentCommander({ sendCommand: () => true }) });
  assert.equal((await request(app).post('/api/burst').send({ agentId: 9, target: '10.14.0.11' })).status, 401);
  assert.equal((await start(app, { agentId: 9, target: '10.14.0.11' }, 'viewer')).status, 403);
  assert.equal((await start(app, { agentId: 9, target: '10.14.0.11' })).status, 202);
});

test('starting a burst answers 202, because the agent does the measuring', async () => {
  const burstRunsRepo = makeBurstRunsRepo();
  const sent = [];
  const app = makeApp({
    agentsRepo: agentsRepo(),
    burstRunsRepo,
    agentCommander: makeAgentCommander({ sendCommand: (id, cmd) => { sent.push([id, cmd]); return true; } }),
  });
  const res = await start(app, { agentId: 9, target: '10.14.0.11', seconds: 60, hz: 1 });
  assert.equal(res.status, 202);
  assert.equal(res.body.run.status, 'running', 'the row exists before the samples do');

  const [agentId, cmd] = sent[0];
  assert.equal(agentId, 9);
  assert.equal(cmd.name, 'burst');
  assert.equal(cmd.target, '10.14.0.11');
  assert.equal(cmd.id, res.body.run.id, 'the run id IS the command id');
});

test('an out-of-range request is refused, where the AGENT would clamp', async () => {
  // Deliberate asymmetry: a person filling in a form should be told 3600 is
  // too long; an agent handed a bad number mid-fault should still measure
  // something.
  const app = makeApp({ agentsRepo: agentsRepo(), agentCommander: makeAgentCommander({ sendCommand: () => true }) });
  for (const body of [
    { agentId: 9, target: '10.14.0.11', seconds: 3600 },
    { agentId: 9, target: '10.14.0.11', seconds: 1 },
    { agentId: 9, target: '10.14.0.11', hz: 50 },
    { agentId: 9, target: 'http://10.14.0.11' },
    { agentId: 9 },
    { target: '10.14.0.11' },
  ]) {
    assert.equal((await start(app, body)).status, 400, JSON.stringify(body));
  }
});

test('a tcp burst without a port is refused rather than guessing one', async () => {
  // Defaulting it would measure a port nobody asked about and report the
  // answer as if they had.
  const app = makeApp({ agentsRepo: agentsRepo(), agentCommander: makeAgentCommander({ sendCommand: () => true }) });
  assert.equal((await start(app, { agentId: 9, target: '10.14.0.11', probe: 'tcp' })).status, 400);
  assert.equal((await start(app, { agentId: 9, target: '10.14.0.11', probe: 'tcp', port: 443 })).status, 202);
});

test('an agent nobody has is 404', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), agentCommander: makeAgentCommander({ sendCommand: () => true }) });
  assert.equal((await start(app, { agentId: 999, target: '10.14.0.11' })).status, 404);
});

test('a disconnected agent is 409, and the failure is RECORDED', async () => {
  // A dispatch that vanished is the one outcome nobody can diagnose. The row
  // already exists, so the refusal is stored rather than leaving a `running`
  // row nobody will ever complete.
  const burstRunsRepo = makeBurstRunsRepo();
  const app = makeApp({
    agentsRepo: agentsRepo(), burstRunsRepo,
    agentCommander: makeAgentCommander({ sendCommand: () => false }),
  });
  const res = await start(app, { agentId: 9, target: '10.14.0.11' });
  assert.equal(res.status, 409);
  assert.ok(res.body.runId);

  const run = await burstRunsRepo.findById(res.body.runId);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /not connected/);
});

test('a repository failure surfaces as 500', async () => {
  const app = makeApp({
    agentsRepo: agentsRepo(),
    burstRunsRepo: makeBurstRunsRepo({ start: throwingAsync('burst_runs down') }),
    agentCommander: makeAgentCommander({ sendCommand: () => true }),
  });
  assert.equal((await start(app, { agentId: 9, target: '10.14.0.11' })).status, 500);
});

// =========================================================== the result
test('a finished burst is analysed once and STORED with its verdict', async () => {
  // So the row reads the same in a report six weeks later as it did on screen.
  const burstRunsRepo = makeBurstRunsRepo();
  const service = createBurstService({
    burstRunsRepo,
    agentCommander: makeAgentCommander({ sendCommand: () => true }),
  });
  const { run } = await service.start({ agentId: 9, target: '10.14.0.11', seconds: 38, hz: 1 });

  const stored = await service.recordResult(9, run.id, {
    ok: true, plan: { hz: 1 }, cancelled: false,
    samples: series(38, [11, 12, 13, 27, 28]),
  });
  assert.equal(stored.status, 'complete');
  assert.equal(stored.lostCount, 5);
  assert.equal(stored.lossClusters, 2);
  assert.equal(stored.pattern, 'clustered');
  assert.match(stored.explanation, /not congestion/);
});

test('an agent CANNOT complete another agent\'s run', async () => {
  // The ownership rule, the same one the SNMP ingest applies.
  const burstRunsRepo = makeBurstRunsRepo();
  const service = createBurstService({
    burstRunsRepo,
    agentCommander: makeAgentCommander({ sendCommand: () => true }),
  });
  const { run } = await service.start({ agentId: 9, target: '10.14.0.11', seconds: 10, hz: 1 });

  assert.equal(await service.recordResult(11, run.id, { ok: true, samples: series(10) }), null);
  assert.equal((await burstRunsRepo.findById(run.id)).status, 'running', 'untouched');
});

test('a duplicate result does not overwrite the first answer', async () => {
  // A reconnect replaying a frame would otherwise replace a stored verdict
  // with a truncated one.
  const burstRunsRepo = makeBurstRunsRepo();
  const service = createBurstService({
    burstRunsRepo,
    agentCommander: makeAgentCommander({ sendCommand: () => true }),
  });
  const { run } = await service.start({ agentId: 9, target: '10.14.0.11', seconds: 20, hz: 1 });

  await service.recordResult(9, run.id, { ok: true, plan: { hz: 1 }, samples: series(20, [5, 6]) });
  await service.recordResult(9, run.id, { ok: true, plan: { hz: 1 }, samples: series(3) });

  const stored = await burstRunsRepo.findById(run.id);
  assert.equal(stored.sampleCount, 20, 'the first answer stands');
});

test('a result for a run nobody has is dropped, not thrown on', async () => {
  const service = createBurstService({
    burstRunsRepo: makeBurstRunsRepo(),
    agentCommander: makeAgentCommander({ sendCommand: () => true }),
  });
  assert.equal(await service.recordResult(9, 999, { ok: true, samples: [] }), null);
  assert.equal(await service.recordResult(9, 'nope', { ok: true, samples: [] }), null);
});

test('a burst the agent could not run is recorded as failed, with the reason', async () => {
  const burstRunsRepo = makeBurstRunsRepo();
  const service = createBurstService({
    burstRunsRepo,
    agentCommander: makeAgentCommander({ sendCommand: () => true }),
  });
  const { run } = await service.start({ agentId: 9, target: '10.14.0.11', seconds: 10, hz: 1 });
  const stored = await service.recordResult(9, run.id, { ok: false, error: 'a burst is already running on this agent' });
  assert.equal(stored.status, 'failed');
  assert.match(stored.error, /already running/);
});

test('a cancelled burst keeps its partial series and says it was cancelled', async () => {
  const burstRunsRepo = makeBurstRunsRepo();
  const service = createBurstService({
    burstRunsRepo,
    agentCommander: makeAgentCommander({ sendCommand: () => true }),
  });
  const { run } = await service.start({ agentId: 9, target: '10.14.0.11', seconds: 120, hz: 1 });
  const stored = await service.recordResult(9, run.id, {
    ok: true, cancelled: true, plan: { hz: 1 }, samples: series(14, [5, 6, 7]),
  });
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.sampleCount, 14, 'what it did measure is still worth having');
});

// =========================================================== reading them
test('a list read omits the series; opening one carries it', async () => {
  // 240 points per row would make a page of twenty runs an order of magnitude
  // larger for data nobody plots until they open one.
  const burstRunsRepo = makeBurstRunsRepo();
  const service = createBurstService({ burstRunsRepo, agentCommander: makeAgentCommander({ sendCommand: () => true }) });
  const { run } = await service.start({ agentId: 9, target: '10.14.0.11', seconds: 20, hz: 1 });
  await service.recordResult(9, run.id, { ok: true, plan: { hz: 1 }, samples: series(20, [5, 6]) });

  const app = makeApp({ agentsRepo: agentsRepo(), burstRunsRepo });
  const list = await request(app).get('/api/burst').set('Authorization', authHeader('viewer'));
  assert.equal(list.status, 200);
  assert.equal(list.body.runs.length, 1);
  assert.equal(list.body.runs[0].samples, undefined, 'no series in the list');
  assert.equal(list.body.runs[0].pattern, 'clustered', 'but the verdict is there');

  const one = await request(app).get(`/api/burst/${run.id}`).set('Authorization', authHeader('viewer'));
  assert.equal(one.body.run.samples.length, 20);
});

test('reading is viewer+, because a finished burst is a measurement', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), burstRunsRepo: makeBurstRunsRepo() });
  assert.equal((await request(app).get('/api/burst')).status, 401);
  assert.equal((await request(app).get('/api/burst').set('Authorization', authHeader('viewer'))).status, 200);
});

test('an out-of-range query is 400 and a missing run is 404', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), burstRunsRepo: makeBurstRunsRepo() });
  assert.equal((await request(app).get('/api/burst?limit=0').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app).get('/api/burst?agentId=abc').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app).get('/api/burst?agentId=999').set('Authorization', authHeader('viewer'))).status, 404);
  assert.equal((await request(app).get('/api/burst/999').set('Authorization', authHeader('viewer'))).status, 404);
  assert.equal((await request(app).get('/api/burst/abc').set('Authorization', authHeader('viewer'))).status, 400);
});

// =========================================================== stopping
test('a read that throws is a 500, not a half-drawn screen', async () => {
  // Both reads go through the same handler shape, so both are checked: a list
  // that swallowed a repository error would show "no bursts yet" for a table
  // that is simply unreachable.
  const app = makeApp({
    agentsRepo: agentsRepo(),
    burstRunsRepo: makeBurstRunsRepo({
      list: throwingAsync('burst_runs down'),
      findById: throwingAsync('burst_runs down'),
    }),
  });
  assert.equal((await request(app).get('/api/burst').set('Authorization', authHeader('viewer'))).status, 500);
  assert.equal((await request(app).get('/api/burst/7').set('Authorization', authHeader('viewer'))).status, 500);
});

test('stopping is operator+, 202, and 409 once the burst has finished', async () => {
  const burstRunsRepo = makeBurstRunsRepo();
  const service = createBurstService({ burstRunsRepo, agentCommander: makeAgentCommander({ sendCommand: () => true }) });
  const { run } = await service.start({ agentId: 9, target: '10.14.0.11', seconds: 120, hz: 1 });

  const app = makeApp({
    agentsRepo: agentsRepo(), burstRunsRepo,
    agentCommander: makeAgentCommander({ sendCommand: () => true }),
  });
  assert.equal((await request(app).post(`/api/burst/${run.id}/stop`).set('Authorization', authHeader('viewer'))).status, 403);
  assert.equal((await request(app).post(`/api/burst/${run.id}/stop`).set('Authorization', authHeader('operator'))).status, 202);

  await service.recordResult(9, run.id, { ok: true, cancelled: true, plan: { hz: 1 }, samples: series(12) });
  const late = await request(app).post(`/api/burst/${run.id}/stop`).set('Authorization', authHeader('operator'));
  assert.equal(late.status, 409);
  assert.equal(late.body.status, 'cancelled');
});

test('a run that never reported can be reconciled rather than looking live', async () => {
  // Left `running` forever it would look like a measurement still happening.
  const burstRunsRepo = makeBurstRunsRepo();
  const anHourAgo = new Date(Date.now() - 3600_000);
  const service = createBurstService({
    burstRunsRepo,
    agentCommander: makeAgentCommander({ sendCommand: () => true }),
    now: () => anHourAgo,
  });
  const { run } = await service.start({ agentId: 9, target: '10.14.0.11', seconds: 120, hz: 1 });
  assert.equal(await burstRunsRepo.expireStale(new Date(Date.now() - 600_000)), 1);
  const stored = await burstRunsRepo.findById(run.id);
  assert.equal(stored.status, 'failed');
  assert.match(stored.error, /never reported/);
});

test('starting a burst reconciles the abandoned ones, so the list has no phantoms', async () => {
  // There is no sweeper for this and there does not need to be: the only person
  // who cares that a week-old run still says "running" is the one about to look
  // at the list, and they are here.
  const burstRunsRepo = makeBurstRunsRepo();
  const commander = makeAgentCommander({ sendCommand: () => true });
  const anHourAgo = new Date(Date.now() - 3600_000);

  const stale = (await createBurstService({ burstRunsRepo, agentCommander: commander, now: () => anHourAgo })
    .start({ agentId: 9, target: '10.14.0.11', seconds: 120, hz: 1 })).run;
  assert.equal((await burstRunsRepo.findById(stale.id)).status, 'running');

  await createBurstService({ burstRunsRepo, agentCommander: commander })
    .start({ agentId: 9, target: '10.14.0.12', seconds: 60, hz: 1 });

  const reconciled = await burstRunsRepo.findById(stale.id);
  assert.equal(reconciled.status, 'failed');
  assert.match(reconciled.error, /never reported/);
});

test('a housekeeping failure never costs the measurement somebody is waiting for', async () => {
  const burstRunsRepo = makeBurstRunsRepo({
    expireStale: async () => { throw new Error('burst_runs down'); },
  });
  const service = createBurstService({
    burstRunsRepo, agentCommander: makeAgentCommander({ sendCommand: () => true }),
  });
  const out = await service.start({ agentId: 9, target: '10.14.0.11', seconds: 60, hz: 1 });
  assert.ok(out.run, 'the burst still started');
});
