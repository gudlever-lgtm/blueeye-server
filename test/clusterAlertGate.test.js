'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createClusterAlertGate } = require('../src/analysis/clusterAlertGate');
const { createAnalysisPipeline } = require('../src/analysis/pipeline');
const { makeIncidentClustersRepo, makeFindingStore, makeDispatcher, makeIntegrationsDispatcher } = require('../test-support/fakes');
const { loadConfig } = require('../src/analysis/config');

// ---- gate: which hosts are suppressed --------------------------------------

async function gateWith(clusters) {
  const clustersRepo = makeIncidentClustersRepo();
  const findingStore = makeFindingStore();
  for (const c of clusters) {
    for (const m of c.members) findingStore.rows.push({ id: m.id, hostId: m.hostId, metric: 'cpu', severity: 'WARN', explanation: 'x', evidence: [{}], createdAt: new Date(), acked: false });
    await clustersRepo.create({ confidence: c.confidence, memberFindingIds: c.members.map((m) => m.id), status: 'open', detectedAt: new Date() });
  }
  const gate = createClusterAlertGate({ clustersRepo, findingStore });
  await gate.ensureFresh();
  return gate;
}

test('gate suppresses hosts covered by an open medium/high cluster', async () => {
  const gate = await gateWith([{ confidence: 'high', members: [{ id: 'a', hostId: '1' }, { id: 'b', hostId: '2' }] }]);
  assert.ok(gate.suppressedCluster({ hostId: '1' }));
  assert.ok(gate.suppressedCluster({ hostId: '2' }));
  assert.equal(gate.suppressedCluster({ hostId: '99' }), null); // uncovered host
});

test('gate does NOT suppress hosts in a LOW cluster (they keep per-finding alerts)', async () => {
  const gate = await gateWith([{ confidence: 'low', members: [{ id: 'a', hostId: '1' }, { id: 'b', hostId: '2' }] }]);
  assert.equal(gate.suppressedCluster({ hostId: '1' }), null);
});

// ---- pipeline: suppressed findings skip dispatch + ITSM emit ---------------

const stubDetector = () => ({
  evaluate: (s) => (s.metric === 'cpu' ? {
    id: 'f-cpu', hostId: s.hostId, metric: 'cpu', kind: 'ANOMALY', severity: 'CRIT',
    explanation: 'x', evidence: [s], correlatedWith: [], createdAt: new Date(),
  } : null),
});
const extract = () => [{ hostId: '9', metric: 'cpu', value: 1, ts: new Date() }];
const cfg = () => ({ ...loadConfig({}), analysisEnabled: true });

test('pipeline suppresses the individual alert + ITSM emit for a clustered host', async () => {
  const dispatcher = makeDispatcher();
  const integrationTrigger = makeIntegrationsDispatcher();
  const clusterAlertGate = { ensureFresh: async () => {}, suppressedCluster: (f) => (String(f.hostId) === '9' ? 5 : null) };
  const pipe = createAnalysisPipeline({
    detector: stubDetector(), findingStore: makeFindingStore(), extract, config: cfg(),
    dispatcher, alertingEnabled: true, integrationTrigger, clusterAlertGate,
  });
  await pipe.processResults('9', [{}]);
  assert.equal(dispatcher.calls.length, 0); // individual alert suppressed
  assert.equal(integrationTrigger.calls.filter((c) => c.kind === 'finding').length, 0); // ITSM emit suppressed
});

test('pipeline still alerts an UNclustered host normally', async () => {
  const dispatcher = makeDispatcher();
  const integrationTrigger = makeIntegrationsDispatcher();
  const clusterAlertGate = { ensureFresh: async () => {}, suppressedCluster: () => null };
  const pipe = createAnalysisPipeline({
    detector: stubDetector(), findingStore: makeFindingStore(), extract, config: cfg(),
    dispatcher, alertingEnabled: true, integrationTrigger, clusterAlertGate,
  });
  await pipe.processResults('9', [{}]);
  assert.equal(dispatcher.calls.length, 1);
  assert.equal(integrationTrigger.calls.filter((c) => c.kind === 'finding').length, 1);
});
