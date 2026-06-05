'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createProbePipeline } = require('../src/analysis/probePipeline');
const { makeFindingStore, makeProbeResultsRepo, makeDispatcher } = require('../test-support/fakes');

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
