'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeEnrollmentStore, makeIntegrationsDispatcher, authHeader } = require('../test-support/fakes');
const { createAnalysisPipeline } = require('../src/analysis/pipeline');
const { createProbePipeline } = require('../src/analysis/probePipeline');

// ---- Route wiring (enroll / delete) ---------------------------------------

test('agent enroll fires an integration agent.enroll event', async () => {
  const dispatcher = makeIntegrationsDispatcher();
  const enrollmentStore = makeEnrollmentStore({ claimAndEnroll: async () => ({ status: 'ok', agentId: 42 }) });
  const app = makeApp({ enrollmentStore, integrationsDispatcher: dispatcher });
  const res = await request(app).post('/agents/enroll').send({ code: 'a-code', hostname: 'node-01', platform: 'linux', arch: 'x64' });
  assert.equal(res.status, 201);
  const call = dispatcher.calls.find((c) => c.kind === 'agent.enroll');
  assert.ok(call, 'expected an agent.enroll emit');
  assert.equal(call.agent.id, 42);
  assert.equal(call.agent.hostname, 'node-01');
});

test('agent delete fires an integration agent.delete event with the agent snapshot', async () => {
  const dispatcher = makeIntegrationsDispatcher();
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'host-9', location_id: 3 }), remove: async () => true });
  const app = makeApp({ agentsRepo, integrationsDispatcher: dispatcher });
  const res = await request(app).delete('/agents/9').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 204);
  const call = dispatcher.calls.find((c) => c.kind === 'agent.delete');
  assert.ok(call, 'expected an agent.delete emit');
  assert.equal(call.agent.id, 9);
  assert.equal(call.agent.hostname, 'host-9');
});

test('agent delete that 404s does NOT fire an event', async () => {
  const dispatcher = makeIntegrationsDispatcher();
  const agentsRepo = makeAgentsRepo({ findById: async () => null, remove: async () => false });
  const app = makeApp({ agentsRepo, integrationsDispatcher: dispatcher });
  const res = await request(app).delete('/agents/9').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 404);
  assert.equal(dispatcher.calls.length, 0);
});

// ---- Pipeline wiring (findings) -------------------------------------------

function fakeFindingStore() {
  const rows = [];
  return { rows, save: async (f) => { rows.push(f); }, list: async () => [], setCorrelations: async () => true };
}

test('the analysis pipeline forwards produced findings to the integration trigger', async () => {
  const finding = { id: 'f1', hostId: 'a1', metric: 'cpu', kind: 'spike', severity: 'CRIT', explanation: 'x' };
  const emitted = [];
  const integrationTrigger = { emitFinding: async (f) => { emitted.push(f); } };
  const pipeline = createAnalysisPipeline({
    detector: { evaluate: () => finding },
    findingStore: fakeFindingStore(),
    config: { analysisEnabled: true },
    extract: () => [{ metric: 'cpu', hostId: 'a1' }],
    integrationTrigger,
  });
  await pipeline.processResults('a1', [{ any: 'payload' }]);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].id, 'f1');
});

test('the probe pipeline forwards produced findings to the integration trigger', async () => {
  const finding = { id: 'p1', hostId: 'a1', metric: 'probe.loss', kind: 'loss', severity: 'WARN', explanation: 'x', evidence: [{ target: 't' }] };
  const emitted = [];
  const integrationTrigger = { emitFinding: async (f) => { emitted.push(f); } };
  const pipeline = createProbePipeline({
    probeResultsRepo: { findByAgent: async () => [{ ok: true }] },
    findingStore: fakeFindingStore(),
    config: { analysisEnabled: true },
    evaluate: () => [finding],
    integrationTrigger,
  });
  await pipeline.processAgent('a1');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].id, 'p1');
});

test('a throwing integration trigger never breaks ingestion', async () => {
  const finding = { id: 'f1', hostId: 'a1', metric: 'cpu', kind: 'spike', severity: 'CRIT', explanation: 'x' };
  const integrationTrigger = { emitFinding: () => { throw new Error('boom'); } };
  const pipeline = createAnalysisPipeline({
    detector: { evaluate: () => finding },
    findingStore: fakeFindingStore(),
    config: { analysisEnabled: true },
    extract: () => [{ metric: 'cpu', hostId: 'a1' }],
    integrationTrigger,
  });
  const produced = await pipeline.processResults('a1', [{ any: 'payload' }]);
  assert.equal(produced.length, 1); // ingestion + findings unaffected
});
