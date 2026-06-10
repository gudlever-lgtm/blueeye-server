'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAuditEventsRepo, makeAgentTokensRepo, makeAgentsRepo,
} = require('../test-support/fakes');

const settle = () => new Promise((r) => setImmediate(r));

// Agent token resolving to agent_id 9.
const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
const agentHdr = (app, path) => request(app).post(path).set('Authorization', 'Bearer agent-tok');

test('continuous traffic reports collapse to one recurring audit row', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  const app = makeApp({ auditEventsRepo, agentTokensRepo: agentToken(), agentsRepo: makeAgentsRepo() });

  for (let i = 0; i < 3; i += 1) {
    const res = await agentHdr(app, '/agents/results').send({ results: [{ name: 'auto-report', ok: true }] });
    assert.equal(res.status, 201);
    await settle();
  }
  const traffic = auditEventsRepo.rows.filter((r) => r.action === 'agent.traffic-report');
  assert.equal(traffic.length, 1, 'only one row for repeated reporting');
  assert.equal(traffic[0].occurrences, 3, 'repeats are folded onto it');
  assert.equal(traffic[0].actorType, 'agent');
  assert.equal(traffic[0].actorId, 9);
});

test('a commanded run-test is recorded as a distinct event', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  const app = makeApp({ auditEventsRepo, agentTokensRepo: agentToken(), agentsRepo: makeAgentsRepo() });
  await agentHdr(app, '/agents/results').send({ results: [{ name: 'run-test', commandId: 'c1', ok: true }] });
  await settle();
  await agentHdr(app, '/agents/results').send({ results: [{ name: 'run-test', commandId: 'c2', ok: true }] });
  await settle();
  const runs = auditEventsRepo.rows.filter((r) => r.action === 'agent.run-test');
  assert.equal(runs.length, 2, 'commanded runs are not deduped');
});

test('probe results dedupe per (type → target); repeats bump occurrences', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  const app = makeApp({ auditEventsRepo, agentTokensRepo: agentToken(), agentsRepo: makeAgentsRepo() });

  const batch = { results: [
    { type: 'ping', target: '8.8.8.8', ok: true },
    { type: 'dns', target: 'example.com', ok: true },
  ] };
  await agentHdr(app, '/agents/probe-results').send(batch);
  await settle();
  await agentHdr(app, '/agents/probe-results').send(batch); // scheduled repeat
  await settle();

  const probes = auditEventsRepo.rows.filter((r) => r.action === 'agent.probe');
  assert.equal(probes.length, 2, 'one row per distinct target');
  for (const p of probes) assert.equal(p.occurrences, 2, 'second batch folds in');
  assert.ok(probes.some((p) => p.targetType === 'ping' && p.targetLabel === '8.8.8.8'));
});

test('agent auditing never blocks ingestion when the audit write throws', async () => {
  const auditEventsRepo = makeAuditEventsRepo({ recordRecurring: async () => { throw new Error('db down'); } });
  const app = makeApp({ auditEventsRepo, agentTokensRepo: agentToken(), agentsRepo: makeAgentsRepo() });
  const res = await agentHdr(app, '/agents/results').send({ results: [{ name: 'auto-report', ok: true }] });
  assert.equal(res.status, 201); // ingestion still succeeds
});
