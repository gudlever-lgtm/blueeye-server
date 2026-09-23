'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createProbePipeline } = require('../src/analysis/probePipeline');
const { makeFindingStore, makeProbeResultsRepo, makeDispatcher, makeEventCaseService } = require('../test-support/fakes');

const T = '2026-06-01T12:00:00.000Z';
const now = () => new Date(T);
const downRows = [{ ts: T, type: 'ping', target: '1.1.1.1', ok: false, lossPct: 100 }];

test('processAgent saves a finding, publishes it and dispatches when alerting is on', async () => {
  const findingStore = makeFindingStore();
  const dispatcher = makeDispatcher();
  const published = [];
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => downRows });
  const pipe = createProbePipeline({
    probeResultsRepo, findingStore, dispatcher,
    config: { analysisEnabled: true }, alertingEnabled: true, licensed: () => true,
    publishFinding: (hostId, msg) => published.push({ hostId, msg }), now,
  });
  const produced = await pipe.processAgent(7);
  assert.equal(produced.length, 1);
  assert.equal(produced[0].metric, 'probe.reachability');
  assert.equal(findingStore.rows.length, 1);
  assert.equal(dispatcher.calls.length, 1);
  assert.equal(published.length, 1);
});

test('processAgent de-dupes against a recent identical finding', async () => {
  const findingStore = makeFindingStore();
  await findingStore.save({ hostId: '7', metric: 'probe.reachability', explanation: 'x', evidence: [{ target: '1.1.1.1' }], createdAt: new Date(T) });
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => downRows });
  const pipe = createProbePipeline({ probeResultsRepo, findingStore, config: { analysisEnabled: true }, licensed: () => true, now });
  const produced = await pipe.processAgent(7);
  assert.equal(produced.length, 0); // suppressed within cooldown
});

test('processAgent does nothing when analysis is disabled', async () => {
  const findingStore = makeFindingStore();
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => downRows });
  const pipe = createProbePipeline({ probeResultsRepo, findingStore, config: { analysisEnabled: false }, licensed: () => true, now });
  assert.deepEqual(await pipe.processAgent(7), []);
  assert.equal(findingStore.rows.length, 0);
});

test('processAgent does nothing when the analysis license is absent', async () => {
  const findingStore = makeFindingStore();
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => downRows });
  const pipe = createProbePipeline({ probeResultsRepo, findingStore, config: { analysisEnabled: true }, licensed: () => false, now });
  assert.deepEqual(await pipe.processAgent(7), []);
  assert.equal(findingStore.rows.length, 0);
});

test('processAgent routes each produced finding to the event-case service', async () => {
  const findingStore = makeFindingStore();
  const eventCaseService = makeEventCaseService();
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => downRows });
  const pipe = createProbePipeline({
    probeResultsRepo, findingStore, eventCaseService,
    config: { analysisEnabled: true }, licensed: () => true, now,
  });
  const produced = await pipe.processAgent(7);
  assert.equal(produced.length, 1);
  assert.equal(eventCaseService.calls.length, 1);
  assert.equal(eventCaseService.calls[0].metric, 'probe.reachability');
});

test('a failing event-case service never breaks probe ingestion', async () => {
  const findingStore = makeFindingStore();
  const eventCaseService = makeEventCaseService({ assignFinding: async () => { throw new Error('boom'); } });
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => downRows });
  const pipe = createProbePipeline({
    probeResultsRepo, findingStore, eventCaseService,
    config: { analysisEnabled: true }, licensed: () => true, now,
  });
  const produced = await pipe.processAgent(7);
  assert.equal(produced.length, 1); // still produced despite the service throwing
});

// ---------------------------------------------------------------------------
// Severity rules: what is published, grouped and alerted is the STORED finding.

test('a severity rule that DOWNGRADES a probe finding changes the dispatched severity', async () => {
  const { FindingStore } = require('../src/analysis/findings');
  const { makeSeverityRulesRepo, makeIntegrationsDispatcher } = require('../test-support/fakes');
  // Real store, scripted pool: the INSERT succeeds and the cooldown read is empty.
  const pool = { query: async () => [[]] };
  const findingStore = new FindingStore({
    db: { pool },
    severityRules: makeSeverityRulesRepo([{ source: 'finding', match_metric: 'probe.reachability', severity: 'INFO', reason: 'lab target' }]),
  });
  const dispatcher = makeDispatcher();
  const eventCaseService = makeEventCaseService();
  const integrationTrigger = makeIntegrationsDispatcher();
  const published = [];
  const pipe = createProbePipeline({
    probeResultsRepo: makeProbeResultsRepo({ findByAgent: async () => downRows }),
    findingStore, dispatcher, eventCaseService, integrationTrigger,
    config: { analysisEnabled: true }, alertingEnabled: true, licensed: () => true, now,
    publishFinding: (hostId, msg) => published.push(msg.payload),
  });
  const [produced] = await pipe.processAgent(7);
  assert.equal(produced.severity, 'INFO');
  assert.equal(produced.originalSeverity, 'CRIT', 'the detector said CRIT; the rule said INFO');
  assert.equal(dispatcher.calls[0].finding.severity, 'INFO', 'the alert carries the rule\'s severity, not the draft\'s');
  assert.equal(published[0].severity, 'INFO');
  assert.equal(eventCaseService.calls[0].severity, 'INFO');
  assert.equal(integrationTrigger.calls[0].finding.severity, 'INFO');
});

test('a store that returns nothing from save() still dispatches the original finding', async () => {
  const dispatcher = makeDispatcher();
  const findingStore = makeFindingStore({ save: async () => undefined });
  const pipe = createProbePipeline({
    probeResultsRepo: makeProbeResultsRepo({ findByAgent: async () => downRows }),
    findingStore, dispatcher,
    config: { analysisEnabled: true }, alertingEnabled: true, licensed: () => true, now,
  });
  const produced = await pipe.processAgent(7);
  assert.equal(produced.length, 1);
  assert.equal(dispatcher.calls[0].finding.metric, 'probe.reachability');
});

// ---------------------------------------------------------------------------
// clusterAlertGate: a probe finding on a clustered host does not alert alone.

test('probe findings on a host covered by an open cluster skip the individual alert + ITSM emit', async () => {
  const { makeIntegrationsDispatcher } = require('../test-support/fakes');
  const dispatcher = makeDispatcher();
  const integrationTrigger = makeIntegrationsDispatcher();
  const eventCaseService = makeEventCaseService();
  let refreshed = 0;
  const clusterAlertGate = {
    ensureFresh: async () => { refreshed += 1; },
    suppressedCluster: (f) => (String(f.hostId) === '7' ? 5 : null),
  };
  const findingStore = makeFindingStore();
  const pipe = createProbePipeline({
    probeResultsRepo: makeProbeResultsRepo({ findByAgent: async () => downRows }),
    findingStore, dispatcher, integrationTrigger, eventCaseService, clusterAlertGate,
    config: { analysisEnabled: true }, alertingEnabled: true, licensed: () => true, now,
  });
  const produced = await pipe.processAgent(7);
  assert.equal(produced.length, 1, 'still detected and stored');
  assert.equal(findingStore.rows.length, 1);
  assert.equal(eventCaseService.calls.length, 1, 'still grouped into an event case');
  assert.equal(refreshed, 1);
  assert.equal(dispatcher.calls.length, 0, 'the individual alert is rolled into the cluster');
  assert.equal(integrationTrigger.calls.filter((c) => c.kind === 'finding').length, 0);
});

test('probe findings on an UNclustered host still alert normally', async () => {
  const { makeIntegrationsDispatcher } = require('../test-support/fakes');
  const dispatcher = makeDispatcher();
  const integrationTrigger = makeIntegrationsDispatcher();
  const pipe = createProbePipeline({
    probeResultsRepo: makeProbeResultsRepo({ findByAgent: async () => downRows }),
    findingStore: makeFindingStore(), dispatcher, integrationTrigger,
    clusterAlertGate: { ensureFresh: async () => { throw new Error('stale'); }, suppressedCluster: () => null },
    config: { analysisEnabled: true }, alertingEnabled: true, licensed: () => true, now,
  });
  await pipe.processAgent(7);
  assert.equal(dispatcher.calls.length, 1);
  assert.equal(integrationTrigger.calls.filter((c) => c.kind === 'finding').length, 1);
});

// ---------------------------------------------------------------------------
// Cooldown vs. event-case activity window.

test('the default re-raise cooldown fits inside the event activity window', () => {
  const { EVENT_ACTIVITY_WINDOW_MS, REFIRE_SLACK_MS, MAX_REFIRE_COOLDOWN_MS } = require('../src/eventCases/activityWindow');
  assert.ok(REFIRE_SLACK_MS > 0);
  assert.equal(MAX_REFIRE_COOLDOWN_MS + REFIRE_SLACK_MS, EVENT_ACTIVITY_WINDOW_MS);
});

test('a probe fault that never clears stays ONE event case for hours (real event-case service)', async () => {
  const { createEventCaseService } = require('../src/eventCases/eventCaseService');
  const { makeEventCasesRepo } = require('../test-support/fakes');
  const eventCasesRepo = makeEventCasesRepo();
  const findingStore = makeFindingStore();
  const eventCaseService = createEventCaseService({ eventCasesRepo, findingStore });
  let clock = Date.parse(T);
  const tick = () => new Date(clock);
  const pipe = createProbePipeline({
    // The target is down on every probe; the rows are always fresh.
    probeResultsRepo: makeProbeResultsRepo({
      findByAgent: async () => [{ ts: tick().toISOString(), type: 'ping', target: '1.1.1.1', ok: false, lossPct: 100 }],
    }),
    findingStore, eventCaseService,
    config: { analysisEnabled: true }, licensed: () => true, now: tick,
  });
  // One probe ingest a minute for three hours.
  for (let m = 0; m < 180; m += 1) {
    await pipe.processAgent(7);
    clock += 60 * 1000;
  }
  assert.ok(findingStore.rows.length > 1, 'the ongoing fault is re-raised after each cooldown');
  assert.equal(eventCasesRepo.rows.length, 1, 'and every re-raise joins the SAME event — no new case every half hour');
});
