'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeIncidentCasesRepo, makeFindingStore, makeAgentsRepo, authHeader } = require('../test-support/fakes');

async function seed() {
  const incidentCasesRepo = makeIncidentCasesRepo();
  const id = await incidentCasesRepo.create({
    host_id: '7', title: 'io storm', status: 'open', severity: 'CRIT', primary_finding_id: 'pf',
    first_event_at: new Date('2026-06-01T00:00:00Z'), last_event_at: new Date('2026-06-01T00:05:00Z'),
  });
  const findingStore = makeFindingStore();
  await findingStore.save({ id: 'pf', hostId: '7', metric: 'io.await', kind: 'ANOMALY', severity: 'CRIT', observed: 40, baseline: 5, deviation: 6.2, explanation: 'io.await at 40 deviated 6.2σ', evidence: [{ metric: 'io.await', value: 40, ts: '2026-06-01T00:00:00Z' }], incidentCaseId: id, createdAt: new Date('2026-06-01T00:00:00Z') });
  const agentsRepo = makeAgentsRepo({ findById: async (aid) => (Number(aid) === 7 ? { id: 7, display_name: 'core-sw-1', hostname: 'h7' } : null) });
  return { incidentCasesRepo, findingStore, agentsRepo, id };
}

test('GET /api/incidents/:id includes a separate explanation (what/where/why) → 200', async () => {
  const { incidentCasesRepo, findingStore, agentsRepo, id } = await seed();
  const app = makeApp({ incidentCasesRepo, findingStore, agentsRepo });
  const res = await request(app).get(`/api/incidents/${id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const ex = res.body.explanation;
  assert.equal(ex.what.anomalyType, 'io.await');
  assert.equal(ex.what.severity, 'CRIT');
  assert.equal(ex.where.device, '7');
  assert.equal(ex.where.deviceLabel, 'core-sw-1');
  // why falls back to raw trigger-data (no confidence model exists yet) — not an error.
  assert.equal(ex.why.source, 'raw_trigger');
  assert.equal(ex.why.deviation, 6.2);
  assert.ok(Array.isArray(ex.why.evidence) && ex.why.evidence.length === 1);
});

test('GET /api/incidents/:id explanation.why is the raw fallback when there is no primary finding', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo();
  const id = await incidentCasesRepo.create({ host_id: '9', title: 'bare', status: 'open', severity: 'WARN', first_event_at: new Date(), last_event_at: new Date() });
  const res = await request(makeApp({ incidentCasesRepo })).get(`/api/incidents/${id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.explanation.what.anomalyType, null);
  assert.equal(res.body.explanation.why.source, 'raw_trigger');
  assert.equal(res.body.explanation.why.available, false);
});
