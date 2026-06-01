'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAnalysisPipeline } = require('../src/analysis/pipeline');
const { makeFindingStore, makeDispatcher } = require('../test-support/fakes');
const { loadConfig } = require('../src/analysis/config');

const stubDetector = () => ({
  evaluate: (s) => (s.metric === 'cpu' ? {
    id: 'id1', hostId: s.hostId, metric: 'cpu', kind: 'ANOMALY', severity: 'CRIT',
    explanation: 'x', evidence: [s], correlatedWith: [], createdAt: new Date(),
  } : null),
});
const extract = () => [{ hostId: '9', metric: 'cpu', value: 1, ts: new Date() }];
const cfg = () => ({ ...loadConfig({}), analysisEnabled: true });

test('pipeline dispatches alerts when alertingEnabled is true', async () => {
  const dispatcher = makeDispatcher();
  const pipe = createAnalysisPipeline({ detector: stubDetector(), findingStore: makeFindingStore(), extract, config: cfg(), dispatcher, alertingEnabled: true });
  await pipe.processResults('9', [{}]);
  assert.equal(dispatcher.calls.length, 1);
  assert.equal(dispatcher.calls[0].finding.metric, 'cpu');
});

test('pipeline does not dispatch when alerting is disabled', async () => {
  const dispatcher = makeDispatcher();
  const pipe = createAnalysisPipeline({ detector: stubDetector(), findingStore: makeFindingStore(), extract, config: cfg(), dispatcher, alertingEnabled: false });
  await pipe.processResults('9', [{}]);
  assert.equal(dispatcher.calls.length, 0);
});

test('a dispatch failure never breaks ingest processing', async () => {
  const dispatcher = makeDispatcher({ dispatch: async () => { throw new Error('boom'); } });
  const pipe = createAnalysisPipeline({ detector: stubDetector(), findingStore: makeFindingStore(), extract, config: cfg(), dispatcher, alertingEnabled: true });
  const produced = await pipe.processResults('9', [{}]);
  assert.equal(produced.length, 1); // findings still produced; dispatch failure swallowed
});
