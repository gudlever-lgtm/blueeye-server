'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeFindingStore, makeInvestigationsRepo,
  makeAssistant, makeIncidentsRepo, authHeader,
} = require('../test-support/fakes');

// Auth headers for each role.
const viewer   = () => authHeader('viewer');
const operator = () => authHeader('operator');
const admin    = () => authHeader('admin');

// Synthetic findings within the last 30 min window.
function recentFinding(hostId, metric = 'rx.errors') {
  return {
    id: `f-${hostId}-${Math.random()}`,
    hostId: String(hostId),
    metric,
    severity: 'CRIT',
    kind: 'ANOMALY',
    observed: 12,
    baseline: 2,
    deviation: 8,
    explanation: `${metric} er anomalt`,
    evidence: [{ ts: new Date().toISOString(), value: 12 }],
    createdAt: new Date().toISOString(),
  };
}

// ---- POST /api/investigation/run -------------------------------------------

test('POST /api/investigation/run returns 401 without token', async () => {
  const res = await request(makeApp()).post('/api/investigation/run')
    .send({ locationRef: { type: 'agent', value: '1' } });
  assert.equal(res.status, 401);
});

test('POST /api/investigation/run returns 403 for viewer role', async () => {
  const res = await request(makeApp()).post('/api/investigation/run')
    .set('Authorization', viewer())
    .send({ locationRef: { type: 'agent', value: '1' } });
  assert.equal(res.status, 403);
});

test('POST /api/investigation/run returns 400 without locationRef', async () => {
  const res = await request(makeApp()).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({});
  assert.equal(res.status, 400);
});

test('POST /api/investigation/run returns 400 for invalid locationRef.type', async () => {
  const res = await request(makeApp()).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'galaxy', value: 'x' } });
  assert.equal(res.status, 400);
});

test('POST /api/investigation/run returns 400 for out-of-range windowMinutes', async () => {
  const res = await request(makeApp()).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' }, windowMinutes: 99999 });
  assert.equal(res.status, 400);
});

test('POST /api/investigation/run returns 200 with a valid InvestigationResult', async () => {
  const agentsRepo = makeAgentsRepo({
    findAll: async () => [{ id: '1', hostname: 'host-a', location_id: 1, status: 'online' }],
  });
  const findingStore = makeFindingStore({
    list: async (hostId) => (hostId === '1' ? [recentFinding('1')] : []),
  });

  const res = await request(makeApp({ agentsRepo, findingStore }))
    .post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  assert.equal(res.status, 200);
  assert.ok(typeof res.body.id === 'string');
  assert.ok(['LOCAL', 'UPSTREAM', 'DOWNSTREAM', 'APP_NOT_NET', 'INSUFFICIENT_DATA'].includes(res.body.classification));
  assert.ok(typeof res.body.explanation === 'string' && res.body.explanation.length > 0);
  assert.ok(Array.isArray(res.body.evidence) && res.body.evidence.length > 0);
  assert.ok(typeof res.body.confidence === 'number');
  assert.ok(Array.isArray(res.body.workaroundHints));
});

test('POST /api/investigation/run returns 200 for admin role', async () => {
  const res = await request(makeApp()).post('/api/investigation/run')
    .set('Authorization', admin())
    .send({ locationRef: { type: 'agent', value: '1' } });
  assert.equal(res.status, 200);
});

test('POST /api/investigation/run returns 500 when locator throws internally', async () => {
  // Simulate agentsRepo throwing on findAll to trigger internal error.
  const agentsRepo = makeAgentsRepo({ findAll: async () => { throw new Error('DB down'); } });
  const res = await request(makeApp({ agentsRepo })).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });
  assert.equal(res.status, 500);
});

// ---- GET /api/investigation -------------------------------------------------

test('GET /api/investigation returns 401 without token', async () => {
  const res = await request(makeApp()).get('/api/investigation');
  assert.equal(res.status, 401);
});

test('GET /api/investigation returns 200 for viewer', async () => {
  const res = await request(makeApp()).get('/api/investigation')
    .set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /api/investigation returns list of investigations', async () => {
  const saved = {
    id: 'inv-abc',
    locationRef: { type: 'agent', value: '1' },
    window: { from: new Date().toISOString(), to: new Date().toISOString() },
    classification: 'LOCAL',
    confidence: 0.8,
    explanation: 'Test investigation',
    evidence: [{ type: 'meta', ref: 'test', observed: 0, baseline: null, deviation: null, ts: new Date().toISOString() }],
    suspectedSegment: null,
    relatedFindingIds: [],
    workaroundHints: [],
    narrative: null,
    createdAt: new Date().toISOString(),
  };
  const investigationsRepo = makeInvestigationsRepo({ list: async () => [saved] });

  const res = await request(makeApp({ investigationsRepo })).get('/api/investigation')
    .set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'inv-abc');
});

test('GET /api/investigation returns 400 for invalid limit', async () => {
  const res = await request(makeApp()).get('/api/investigation?limit=-5')
    .set('Authorization', viewer());
  assert.equal(res.status, 400);
});

// ---- GET /api/investigation/:id ---------------------------------------------

test('GET /api/investigation/:id returns 401 without token', async () => {
  const res = await request(makeApp()).get('/api/investigation/abc123');
  assert.equal(res.status, 401);
});

test('GET /api/investigation/:id returns 404 for unknown id', async () => {
  const res = await request(makeApp()).get('/api/investigation/no-such-id')
    .set('Authorization', viewer());
  assert.equal(res.status, 404);
});

test('GET /api/investigation/:id returns 200 for existing id', async () => {
  const inv = {
    id: 'inv-123',
    locationRef: { type: 'agent', value: '1' },
    window: { from: new Date().toISOString(), to: new Date().toISOString() },
    classification: 'LOCAL',
    confidence: 0.8,
    explanation: 'Fejl på lokalt segment',
    evidence: [{ type: 'finding', ref: '1/rx.errors', observed: 10, baseline: 2, deviation: 8, ts: new Date().toISOString() }],
    suspectedSegment: null,
    relatedFindingIds: ['f1'],
    workaroundHints: ['Tjek kablet'],
    narrative: null,
    createdAt: new Date().toISOString(),
  };
  const investigationsRepo = makeInvestigationsRepo({ findById: async (id) => (id === 'inv-123' ? inv : null) });

  const res = await request(makeApp({ investigationsRepo })).get('/api/investigation/inv-123')
    .set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'inv-123');
  assert.equal(res.body.classification, 'LOCAL');
  assert.ok(typeof res.body.explanation === 'string');
  assert.ok(Array.isArray(res.body.evidence) && res.body.evidence.length > 0);
});

test('GET /api/investigation/:id returns 500 when repo throws', async () => {
  const investigationsRepo = makeInvestigationsRepo({
    findById: async () => { throw new Error('DB error'); },
  });
  const res = await request(makeApp({ investigationsRepo })).get('/api/investigation/bad')
    .set('Authorization', viewer());
  assert.equal(res.status, 500);
});

// ---- POST /api/investigation/from-incident ----------------------------------

test('POST /api/investigation/from-incident returns 401 without token', async () => {
  const res = await request(makeApp()).post('/api/investigation/from-incident')
    .send({ incidentId: '1' });
  assert.equal(res.status, 401);
});

test('POST /api/investigation/from-incident returns 403 for viewer', async () => {
  const res = await request(makeApp()).post('/api/investigation/from-incident')
    .set('Authorization', viewer())
    .send({ incidentId: '1' });
  assert.equal(res.status, 403);
});

test('POST /api/investigation/from-incident returns 400 without incidentId', async () => {
  const res = await request(makeApp()).post('/api/investigation/from-incident')
    .set('Authorization', operator())
    .send({});
  assert.equal(res.status, 400);
});

test('POST /api/investigation/from-incident returns 404 for unknown incident', async () => {
  const incidentsRepo = makeIncidentsRepo();
  const res = await request(makeApp({ incidentsRepo })).post('/api/investigation/from-incident')
    .set('Authorization', operator())
    .send({ incidentId: '9999' });
  assert.equal(res.status, 404);
});

test('POST /api/investigation/from-incident returns 200 when incident found', async () => {
  // Use a pre-shaped fake incident so we control both the ID type and the fields
  // that mapOut would produce (locationId, agentId, metric, severity …).
  const fakeIncident = {
    id: 'inc-001',
    locationId: 1,
    agentId: '1',
    metric: 'latency',
    severity: 'CRIT',
    status: 'active',
  };
  const incidentsRepo = makeIncidentsRepo({
    findById: async (id) => (id === 'inc-001' ? fakeIncident : null),
  });

  const agentsRepo = makeAgentsRepo({
    findAll: async () => [{ id: '1', hostname: 'host-a', location_id: 1, status: 'online' }],
  });

  const res = await request(makeApp({ agentsRepo, incidentsRepo }))
    .post('/api/investigation/from-incident')
    .set('Authorization', operator())
    .send({ incidentId: 'inc-001' });

  assert.equal(res.status, 200);
  assert.ok(res.body.incidentId != null);
  assert.ok(typeof res.body.investigation === 'object');
  assert.ok(['LOCAL', 'UPSTREAM', 'DOWNSTREAM', 'APP_NOT_NET', 'INSUFFICIENT_DATA'].includes(res.body.investigation.classification));
  assert.ok(typeof res.body.investigation.explanation === 'string' && res.body.investigation.explanation.length > 0);
  assert.ok(Array.isArray(res.body.investigation.evidence) && res.body.investigation.evidence.length > 0);
});

// ServiceNow connector not configured — from-incident still works gracefully.
test('POST /api/investigation/from-incident works without ServiceNow connector', async () => {
  const fakeIncident = {
    id: 'inc-002',
    locationId: null,
    agentId: '5',
    metric: 'latency',
    severity: 'WARN',
    status: 'active',
  };
  const incidentsRepo = makeIncidentsRepo({
    findById: async (id) => (id === 'inc-002' ? fakeIncident : null),
  });

  const agentsRepo = makeAgentsRepo({
    findAll: async () => [{ id: '5', hostname: 'host-b', location_id: 2, status: 'online' }],
  });

  const res = await request(makeApp({ agentsRepo, incidentsRepo }))
    .post('/api/investigation/from-incident')
    .set('Authorization', operator())
    .send({ incidentId: 'inc-002' });

  // Even without a ServiceNow connector the investigation runs fine.
  assert.equal(res.status, 200);
  assert.ok(res.body.investigation);
});

// ---- result integrity guarantee ---------------------------------------------

test('guarantee: /run result always has non-empty explanation and evidence', async () => {
  // Run with no matching agents → INSUFFICIENT_DATA, must still have both.
  const agentsRepo = makeAgentsRepo({ findAll: async () => [] });
  const res = await request(makeApp({ agentsRepo })).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: 'ghost-99' } });

  assert.equal(res.status, 200);
  assert.ok(typeof res.body.explanation === 'string' && res.body.explanation.length > 0,
    'explanation must be non-empty even for INSUFFICIENT_DATA');
  assert.ok(Array.isArray(res.body.evidence) && res.body.evidence.length > 0,
    'evidence must be non-empty even for INSUFFICIENT_DATA');
});
