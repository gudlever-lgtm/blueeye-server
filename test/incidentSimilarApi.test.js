'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeIncidentCasesRepo, makeFindingStore, makeAgentsRepo, authHeader } = require('../test-support/fakes');

async function seed() {
  const incidentCasesRepo = makeIncidentCasesRepo();
  // Target (open) — device 9, cpu anomaly.
  const targetId = await incidentCasesRepo.create({ host_id: '9', title: 'target', status: 'open', severity: 'CRIT', primary_finding_id: 'pf', first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:00:00Z') });
  // A: same device + same anomaly type → 5
  await incidentCasesRepo.create({ host_id: '9', title: 'A', status: 'closed', severity: 'CRIT', primary_metric: 'cpu', closed_by_email: 'admin@x', last_event_at: new Date('2026-05-05T00:00:00Z'), resolved_at: new Date('2026-05-05T00:00:00Z') });
  // B: same device only → 3 (resolved later than C)
  await incidentCasesRepo.create({ host_id: '9', title: 'B', status: 'resolved', severity: 'WARN', primary_metric: 'mem', last_event_at: new Date('2026-05-04T00:00:00Z'), resolved_at: new Date('2026-05-04T00:00:00Z') });
  // C: same device-type (platform) + same anomaly type → 3 (resolved earlier)
  await incidentCasesRepo.create({ host_id: '7', title: 'C', status: 'closed', severity: 'WARN', primary_metric: 'cpu', platform: 'linux', last_event_at: new Date('2026-05-03T00:00:00Z'), resolved_at: new Date('2026-05-03T00:00:00Z') });
  // D: nothing in common → dropped
  await incidentCasesRepo.create({ host_id: '99', title: 'D', status: 'closed', severity: 'INFO', primary_metric: 'disk', platform: 'windows', last_event_at: new Date('2026-05-02T00:00:00Z'), resolved_at: new Date('2026-05-02T00:00:00Z') });

  const findingStore = makeFindingStore();
  await findingStore.save({ id: 'pf', hostId: '9', metric: 'cpu', severity: 'CRIT', explanation: 'x', evidence: [{}], createdAt: new Date('2026-06-01T08:00:00Z') });
  const agentsRepo = makeAgentsRepo({ findById: async (aid) => (Number(aid) === 9 ? { id: 9, platform: 'linux' } : null) });
  return { incidentCasesRepo, findingStore, agentsRepo, targetId };
}

test('GET /similar ranks matches by score, most similar first → 200', async () => {
  const { incidentCasesRepo, findingStore, agentsRepo, targetId } = await seed();
  const app = makeApp({ incidentCasesRepo, findingStore, agentsRepo });
  const res = await request(app).get(`/api/incidents/${targetId}/similar`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.similar.map((s) => s.title), ['A', 'B', 'C']); // D dropped
  assert.equal(res.body.similar[0].score, 5);
  assert.deepEqual(res.body.similar[0].matchedOn, ['device', 'anomalyType']);
  assert.equal(res.body.similar[0].closedBy, 'admin@x');
  // playbook history is unavailable in this codebase — surfaced as null
  assert.equal(res.body.similar[0].playbook, null);
  assert.equal(res.body.similar[0].playbookSucceeded, null);
});

test('GET /similar returns an empty list when nothing matches → 200', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo();
  const id = await incidentCasesRepo.create({ host_id: '5', title: 't', status: 'open', severity: 'WARN', first_event_at: new Date(), last_event_at: new Date() });
  const res = await request(makeApp({ incidentCasesRepo })).get(`/api/incidents/${id}/similar`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.similar, []);
});

test('GET /similar is 404 for an unknown incident', async () => {
  const res = await request(makeApp()).get('/api/incidents/9999/similar').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /similar is 400 for a non-numeric id', async () => {
  const res = await request(makeApp()).get('/api/incidents/abc/similar').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /similar surfaces a repo failure as 500', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo({ findById: async () => { throw new Error('db down'); } });
  const res = await request(makeApp({ incidentCasesRepo })).get('/api/incidents/1/similar').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});
