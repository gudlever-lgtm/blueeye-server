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

// Severity rules are applied by FindingStore.save(); the pipeline used to
// dispatch the detector's DRAFT (saved but then discarded the return value), so
// a rule that downgraded a metric still paged at the old severity.
function ruledStore(rules) {
  const { FindingStore } = require('../src/analysis/findings');
  const { makeSeverityRulesRepo } = require('../test-support/fakes');
  return new FindingStore({ db: { pool: { query: async () => [[]] } }, severityRules: makeSeverityRulesRepo(rules) });
}

test('a severity rule that DOWNGRADES a finding changes what is dispatched, published and grouped', async () => {
  const dispatcher = makeDispatcher();
  const published = [];
  const grouped = [];
  const pipe = createAnalysisPipeline({
    detector: stubDetector(), extract, config: cfg(), dispatcher, alertingEnabled: true,
    findingStore: ruledStore([{ source: 'finding', match_metric: 'cpu', severity: 'INFO', reason: 'batch host' }]),
    publishFinding: (hostId, msg) => published.push(msg.payload),
    eventCaseService: { assignFinding: async (f) => grouped.push(f) },
  });
  const [produced] = await pipe.processResults('9', [{}]);
  assert.equal(produced.severity, 'INFO');
  assert.equal(produced.originalSeverity, 'CRIT');
  assert.equal(dispatcher.calls[0].finding.severity, 'INFO');
  assert.equal(published[0].severity, 'INFO');
  assert.equal(grouped[0].severity, 'INFO');
});

test('a severity rule that UPGRADES a finding changes the dispatched severity too', async () => {
  const dispatcher = makeDispatcher();
  const warnDetector = { evaluate: (s) => ({ ...stubDetector().evaluate(s), severity: 'WARN' }) };
  const pipe = createAnalysisPipeline({
    detector: warnDetector, extract, config: cfg(), dispatcher, alertingEnabled: true,
    findingStore: ruledStore([{ source: 'finding', match_metric: 'cpu', severity: 'CRIT', reason: 'critical host' }]),
  });
  await pipe.processResults('9', [{}]);
  assert.equal(dispatcher.calls[0].finding.severity, 'CRIT');
  assert.equal(dispatcher.calls[0].finding.originalSeverity, 'WARN');
});

test('a store whose save() returns nothing still dispatches the original finding', async () => {
  const dispatcher = makeDispatcher();
  const pipe = createAnalysisPipeline({
    detector: stubDetector(), extract, config: cfg(), dispatcher, alertingEnabled: true,
    findingStore: makeFindingStore({ save: async () => undefined }),
  });
  await pipe.processResults('9', [{}]);
  assert.equal(dispatcher.calls[0].finding.id, 'id1');
  assert.equal(dispatcher.calls[0].finding.severity, 'CRIT');
});
