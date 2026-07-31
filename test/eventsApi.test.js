'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeEventCasesRepo, makeFindingStore, authHeader } = require('../test-support/fakes');

// Seeds one event and returns { app, eventCasesRepo, findingStore, id }.
async function withEvent(over = {}) {
  const eventCasesRepo = makeEventCasesRepo();
  const findingStore = makeFindingStore();
  const id = await eventCasesRepo.create({
    host_id: 'core-sw', title: 'CRIT cpu on core-sw', status: over.status || 'open',
    severity: 'CRIT', primary_finding_id: 'f-1',
    first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:05:00Z'),
  });
  const app = makeApp({ eventCasesRepo, findingStore, ...over.appOverrides });
  return { app, eventCasesRepo, findingStore, id };
}

// ---- GET /api/events ----------------------------------------------------

test('GET /api/events returns the list (viewer+) → 200', async () => {
  const { app } = await withEvent();
  const res = await request(app).get('/api/events').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 1);
  assert.equal(res.body.events[0].hostId, 'core-sw');
});

test('GET /api/events carries the device identity (agent + site) on every row', async () => {
  const eventCasesRepo = makeEventCasesRepo({ devices: { 14: { agentName: 'core-sw', locationId: 2, locationName: 'Copenhagen HQ' } } });
  await eventCasesRepo.create({
    host_id: '14', title: 'WARN probe.latency on core-sw (Copenhagen HQ)', severity: 'WARN',
    first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:00:00Z'),
  });
  const app = makeApp({ eventCasesRepo });
  const res = await request(app).get('/api/events').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.events[0].agentName, 'core-sw');
  assert.equal(res.body.events[0].locationName, 'Copenhagen HQ');
  assert.equal(res.body.events[0].locationId, 2);
});

test('GET /api/events/:id explains WHERE the event is', async () => {
  const eventCasesRepo = makeEventCasesRepo({ devices: { 14: { agentName: 'core-sw', locationId: 2, locationName: 'Copenhagen HQ' } } });
  const id = await eventCasesRepo.create({
    host_id: '14', title: 'WARN probe.latency on core-sw (Copenhagen HQ)', severity: 'WARN',
    first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:00:00Z'),
  });
  const app = makeApp({ eventCasesRepo });
  const res = await request(app).get(`/api/events/${id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.event.agentName, 'core-sw');
  assert.equal(res.body.event.locationName, 'Copenhagen HQ');
  assert.equal(res.body.explanation.where.locationName, 'Copenhagen HQ');
  assert.equal(res.body.explanation.where.summary, 'core-sw (Copenhagen HQ)');
});

test('GET /api/events requires auth → 401', async () => {
  const { app } = await withEvent();
  assert.equal((await request(app).get('/api/events')).status, 401);
});

test('GET /api/events rejects an invalid status filter → 400', async () => {
  const { app } = await withEvent();
  const res = await request(app).get('/api/events?status=bogus').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/events passes status/severity/device filters to the repo', async () => {
  const seen = [];
  const eventCasesRepo = makeEventCasesRepo({ list: async (f) => { seen.push(f); return []; } });
  const app = makeApp({ eventCasesRepo });
  const res = await request(app)
    .get('/api/events?status=open&severity=CRIT&device=core-sw')
    .set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(seen[0].status, 'open');
  assert.equal(seen[0].severity, 'CRIT');
  assert.equal(seen[0].hostId, 'core-sw');
});

// ---- GET /api/events/:id ------------------------------------------------

test('GET /api/events/:id returns the event + linked anomalies → 200', async () => {
  const { app, findingStore, id } = await withEvent();
  await findingStore.save({ id: 'f-1', hostId: 'core-sw', metric: 'cpu', severity: 'CRIT', explanation: 'x', evidence: [{}], createdAt: new Date('2026-06-01T08:00:00Z') });
  await findingStore.setEventCase('f-1', id);

  const res = await request(app).get(`/api/events/${id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.event.id, id);
  assert.equal(res.body.anomalies.length, 1);
  assert.equal(res.body.anomalies[0].id, 'f-1');
  assert.deepEqual(res.body.playbookRuns, []);
});

test('GET /api/events/:id enriches with blast radius when the host is numeric', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const findingStore = makeFindingStore();
  const id = await eventCasesRepo.create({
    host_id: 42, title: 'CRIT on 42', status: 'open', severity: 'CRIT',
    first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:05:00Z'),
  });
  let askedFor = null;
  const blastRadiusService = {
    compute: async (hostId) => { askedFor = hostId; return { failingNode: hostId, directly_isolated: [{ hostId: 7, path: [42, 7] }], dependency_affected: [], totals: { directly_isolated: 1, dependency_affected: 0 } }; },
  };
  const app = makeApp({ eventCasesRepo, findingStore, blastRadiusService });
  const res = await request(app).get(`/api/events/${id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(askedFor, 42);
  assert.equal(res.body.event.blastRadius.failingNode, 42);
  assert.equal(res.body.event.blastRadius.directly_isolated[0].hostId, 7);
});

test('GET /api/events/:id tolerates a blast-radius failure (field null, still 200)', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const id = await eventCasesRepo.create({
    host_id: 42, title: 'CRIT on 42', status: 'open', severity: 'CRIT',
    first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:05:00Z'),
  });
  const blastRadiusService = { compute: async () => { throw new Error('topology store down'); } };
  const app = makeApp({ eventCasesRepo, blastRadiusService });
  const res = await request(app).get(`/api/events/${id}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.event.blastRadius, null);
});

test('GET /api/events/:id is 404 for an unknown event', async () => {
  const { app } = await withEvent();
  const res = await request(app).get('/api/events/9999').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /api/events/:id is 400 for a non-numeric id', async () => {
  const { app } = await withEvent();
  const res = await request(app).get('/api/events/abc').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/events/:id surfaces a repo failure as 500', async () => {
  const eventCasesRepo = makeEventCasesRepo({ findById: async () => { throw new Error('db down'); } });
  const app = makeApp({ eventCasesRepo });
  const res = await request(app).get('/api/events/1').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

// ---- PATCH /api/events/:id ----------------------------------------------

test('PATCH is forbidden for a viewer → 403', async () => {
  const { app, id } = await withEvent();
  const res = await request(app).patch(`/api/events/${id}`)
    .set('Authorization', authHeader('viewer')).send({ status: 'investigating' });
  assert.equal(res.status, 403);
});

test('PATCH open→investigating succeeds for an operator and is audited → 200', async () => {
  const audits = [];
  const auditLogger = { enabled: true, record: async (_req, e) => { audits.push(e); } };
  const { app, eventCasesRepo, id } = await withEvent({ appOverrides: { auditLogger } });
  const res = await request(app).patch(`/api/events/${id}`)
    .set('Authorization', authHeader('operator')).send({ status: 'investigating' });
  assert.equal(res.status, 200);
  assert.equal(res.body.event.status, 'investigating');
  assert.equal(eventCasesRepo.rows[0].status, 'investigating');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'event_status_change');
  assert.match(audits[0].detail, /open→investigating/);
});

test('PATCH rejects an illegal transition (open→closed) → 409', async () => {
  const { app, id } = await withEvent();
  const res = await request(app).patch(`/api/events/${id}`)
    .set('Authorization', authHeader('admin')).send({ status: 'closed' });
  assert.equal(res.status, 409);
});

test('PATCH reopen (closed→open) needs a comment → 400 without, 200 with', async () => {
  const { app, eventCasesRepo, id } = await withEvent({ status: 'closed' });
  const without = await request(app).patch(`/api/events/${id}`)
    .set('Authorization', authHeader('operator')).send({ status: 'open' });
  assert.equal(without.status, 400);

  const withComment = await request(app).patch(`/api/events/${id}`)
    .set('Authorization', authHeader('operator')).send({ status: 'open', comment: 'recurred overnight' });
  assert.equal(withComment.status, 200);
  assert.equal(eventCasesRepo.rows[0].status, 'open');
});

test('PATCH is 404 for an unknown event', async () => {
  const { app } = await withEvent();
  const res = await request(app).patch('/api/events/9999')
    .set('Authorization', authHeader('operator')).send({ status: 'investigating' });
  assert.equal(res.status, 404);
});

test('PATCH rejects an invalid status body → 400', async () => {
  const { app, id } = await withEvent();
  const res = await request(app).patch(`/api/events/${id}`)
    .set('Authorization', authHeader('operator')).send({ status: 'wizard' });
  assert.equal(res.status, 400);
});

test('PATCH surfaces a repo failure as 500', async () => {
  const eventCasesRepo = makeEventCasesRepo({ findById: async () => { throw new Error('db down'); } });
  const app = makeApp({ eventCasesRepo });
  const res = await request(app).patch('/api/events/1')
    .set('Authorization', authHeader('operator')).send({ status: 'investigating' });
  assert.equal(res.status, 500);
});

// ---- /api/events is the ONLY path -----------------------------------------
// The operator-facing unit is an EVENT; an *incident* is what a connected ITSM
// opens from one (docs/events.md). The deprecated /api/incidents alias and the
// duplicated `incident*` response keys were removed in the clean break — these
// tests are what proves nothing is quietly still answering on the old surface.

test('GET /api/events is the canonical path and returns the list', async () => {
  const { app } = await withEvent();
  const res = await request(app).get('/api/events').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 1);
  assert.equal(res.body.events[0].hostId, 'core-sw');
});

test('the removed /api/incidents alias is gone (404), not silently served', async () => {
  const { app, id } = await withEvent();
  const [list, detail] = await Promise.all([
    request(app).get('/api/incidents').set('Authorization', authHeader('viewer')),
    request(app).get(`/api/incidents/${id}`).set('Authorization', authHeader('viewer')),
  ]);
  assert.equal(list.status, 404);
  assert.equal(detail.status, 404);
});

test('no response carries a legacy incident* key', async () => {
  const { app, id } = await withEvent();
  const list = await request(app).get('/api/events').set('Authorization', authHeader('viewer'));
  assert.ok(Array.isArray(list.body.events));
  assert.deepEqual(Object.keys(list.body).filter((k) => /incident/i.test(k)), []);

  const detail = await request(app).get(`/api/events/${id}`).set('Authorization', authHeader('viewer'));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.event.id, id);
  assert.deepEqual(Object.keys(detail.body).filter((k) => /incident/i.test(k)), []);
  assert.deepEqual(Object.keys(detail.body.event).filter((k) => /incident/i.test(k)), []);
});

test('a PATCH through the canonical path returns both keys', async () => {
  const { app, id } = await withEvent();
  const res = await request(app).patch(`/api/events/${id}`)
    .set('Authorization', authHeader('operator'))
    .send({ status: 'investigating' });
  assert.equal(res.status, 200);
  assert.equal(res.body.event.status, 'investigating');
  assert.deepEqual(res.body.event, res.body.event);
});

test('an unknown id is an EVENT that was not found', async () => {
  // The noun in our own error text is "event" — "event" would point the reader
  // at their service desk for a record that only ever existed here.
  const { app } = await withEvent();
  const res = await request(app).get('/api/events/99999').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Event not found');
});
