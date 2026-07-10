'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeIncidentCasesRepo, makeFindingStore, authHeader } = require('../test-support/fakes');

// Seeds one incident and returns { app, incidentCasesRepo, findingStore, id }.
async function withIncident(over = {}) {
  const incidentCasesRepo = makeIncidentCasesRepo();
  const findingStore = makeFindingStore();
  const id = await incidentCasesRepo.create({
    host_id: 'core-sw', title: 'CRIT cpu on core-sw', status: over.status || 'open',
    severity: 'CRIT', primary_finding_id: 'f-1',
    first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:05:00Z'),
  });
  const app = makeApp({ incidentCasesRepo, findingStore, ...over.appOverrides });
  return { app, incidentCasesRepo, findingStore, id };
}

// ---- GET /api/incidents ----------------------------------------------------

test('GET /api/incidents returns the list (viewer+) → 200', async () => {
  const { app } = await withIncident();
  const res = await request(app).get('/api/incidents').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.incidents.length, 1);
  assert.equal(res.body.incidents[0].hostId, 'core-sw');
});

test('GET /api/incidents requires auth → 401', async () => {
  const { app } = await withIncident();
  assert.equal((await request(app).get('/api/incidents')).status, 401);
});

test('GET /api/incidents rejects an invalid status filter → 400', async () => {
  const { app } = await withIncident();
  const res = await request(app).get('/api/incidents?status=bogus').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/incidents passes status/severity/device filters to the repo', async () => {
  const seen = [];
  const incidentCasesRepo = makeIncidentCasesRepo({ list: async (f) => { seen.push(f); return []; } });
  const app = makeApp({ incidentCasesRepo });
  const res = await request(app)
    .get('/api/incidents?status=open&severity=CRIT&device=core-sw')
    .set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(seen[0].status, 'open');
  assert.equal(seen[0].severity, 'CRIT');
  assert.equal(seen[0].hostId, 'core-sw');
});

// ---- GET /api/incidents/:id ------------------------------------------------

test('GET /api/incidents/:id returns the incident + linked anomalies → 200', async () => {
  const { app, findingStore, id } = await withIncident();
  await findingStore.save({ id: 'f-1', hostId: 'core-sw', metric: 'cpu', severity: 'CRIT', explanation: 'x', evidence: [{}], createdAt: new Date('2026-06-01T08:00:00Z') });
  await findingStore.setIncidentCase('f-1', id);

  const res = await request(app).get(`/api/incidents/${id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.incident.id, id);
  assert.equal(res.body.anomalies.length, 1);
  assert.equal(res.body.anomalies[0].id, 'f-1');
  assert.deepEqual(res.body.playbookRuns, []);
});

test('GET /api/incidents/:id is 404 for an unknown incident', async () => {
  const { app } = await withIncident();
  const res = await request(app).get('/api/incidents/9999').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /api/incidents/:id is 400 for a non-numeric id', async () => {
  const { app } = await withIncident();
  const res = await request(app).get('/api/incidents/abc').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/incidents/:id surfaces a repo failure as 500', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo({ findById: async () => { throw new Error('db down'); } });
  const app = makeApp({ incidentCasesRepo });
  const res = await request(app).get('/api/incidents/1').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

// ---- PATCH /api/incidents/:id ----------------------------------------------

test('PATCH is forbidden for a viewer → 403', async () => {
  const { app, id } = await withIncident();
  const res = await request(app).patch(`/api/incidents/${id}`)
    .set('Authorization', authHeader('viewer')).send({ status: 'investigating' });
  assert.equal(res.status, 403);
});

test('PATCH open→investigating succeeds for an operator and is audited → 200', async () => {
  const audits = [];
  const auditLogger = { enabled: true, record: async (_req, e) => { audits.push(e); } };
  const { app, incidentCasesRepo, id } = await withIncident({ appOverrides: { auditLogger } });
  const res = await request(app).patch(`/api/incidents/${id}`)
    .set('Authorization', authHeader('operator')).send({ status: 'investigating' });
  assert.equal(res.status, 200);
  assert.equal(res.body.incident.status, 'investigating');
  assert.equal(incidentCasesRepo.rows[0].status, 'investigating');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'incident_status_change');
  assert.match(audits[0].detail, /open→investigating/);
});

test('PATCH rejects an illegal transition (open→closed) → 409', async () => {
  const { app, id } = await withIncident();
  const res = await request(app).patch(`/api/incidents/${id}`)
    .set('Authorization', authHeader('admin')).send({ status: 'closed' });
  assert.equal(res.status, 409);
});

test('PATCH reopen (closed→open) needs a comment → 400 without, 200 with', async () => {
  const { app, incidentCasesRepo, id } = await withIncident({ status: 'closed' });
  const without = await request(app).patch(`/api/incidents/${id}`)
    .set('Authorization', authHeader('operator')).send({ status: 'open' });
  assert.equal(without.status, 400);

  const withComment = await request(app).patch(`/api/incidents/${id}`)
    .set('Authorization', authHeader('operator')).send({ status: 'open', comment: 'recurred overnight' });
  assert.equal(withComment.status, 200);
  assert.equal(incidentCasesRepo.rows[0].status, 'open');
});

test('PATCH is 404 for an unknown incident', async () => {
  const { app } = await withIncident();
  const res = await request(app).patch('/api/incidents/9999')
    .set('Authorization', authHeader('operator')).send({ status: 'investigating' });
  assert.equal(res.status, 404);
});

test('PATCH rejects an invalid status body → 400', async () => {
  const { app, id } = await withIncident();
  const res = await request(app).patch(`/api/incidents/${id}`)
    .set('Authorization', authHeader('operator')).send({ status: 'wizard' });
  assert.equal(res.status, 400);
});

test('PATCH surfaces a repo failure as 500', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo({ findById: async () => { throw new Error('db down'); } });
  const app = makeApp({ incidentCasesRepo });
  const res = await request(app).patch('/api/incidents/1')
    .set('Authorization', authHeader('operator')).send({ status: 'investigating' });
  assert.equal(res.status, 500);
});
