'use strict';

// NIS2 Article 23: the fields a notification asks for, the submission record
// that turns a deadline from "overdue" into "submitted", and drafting a NIS2
// incident from an event case.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeNis2IncidentsRepo, makeEventCasesRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');
const { validateIncidentInput } = require('../src/validation/nis2Validation');
const { draftFromEventCase } = require('../src/routes/nis2/incidents');

const HOUR = 3600 * 1000;
const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString();
const post = (app, path, role, body) => request(app).post(path).set('Authorization', authHeader(role)).send(body);
const put = (app, path, role, body) => request(app).put(path).set('Authorization', authHeader(role)).send(body);
const get = (app, path, role) => request(app).get(path).set('Authorization', authHeader(role));

// --- validation -------------------------------------------------------------------

test('the Art. 23 fields are accepted, normalised and bounded', () => {
  const { value, errors } = validateIncidentInput({
    title: 'Ransomware on file server', detectedAt: '2026-06-01T08:00:00Z',
    suspectedMalicious: true, crossBorderImpact: 'true', crossBorderDetails: 'Customers in SE and NO',
    authorityReference: 'CFCS-2026-0142',
    earlyWarningSubmittedAt: '2026-06-01T20:00:00Z', notificationSubmittedAt: '2026-06-03T09:00:00Z',
  });
  assert.equal(errors, undefined);
  assert.equal(value.suspectedMalicious, true);
  assert.equal(value.crossBorderImpact, true);
  assert.equal(value.authorityReference, 'CFCS-2026-0142');
  assert.equal(value.earlyWarningSubmittedAt, '2026-06-01 20:00:00');
  assert.equal(value.finalReportSubmittedAt, null);

  assert.ok(validateIncidentInput({ title: 'x', authorityReference: 'r'.repeat(129) }).errors.authorityReference);
  assert.ok(validateIncidentInput({ title: 'x', crossBorderDetails: 'd'.repeat(2001) }).errors.crossBorderDetails);
  assert.ok(validateIncidentInput({ title: 'x', notificationSubmittedAt: 'not a date' }).errors.notificationSubmittedAt);
  const early = validateIncidentInput({ title: 'x', detectedAt: '2026-06-02T00:00:00Z', earlyWarningSubmittedAt: '2026-06-01T00:00:00Z' });
  assert.match(early.errors.earlyWarningSubmittedAt, /before detectedAt/, 'a report cannot precede the incident');
});

// --- the register ------------------------------------------------------------------

test('POST + GET: submissions are stored and the deadlines read "submitted"', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  const app = makeApp({ nis2IncidentsRepo });
  const created = await post(app, '/api/nis2/incidents', 'operator', {
    title: 'Outage of payment API', notificationRequired: true, detectedAt: iso(100),
    earlyWarningSubmittedAt: iso(90), suspectedMalicious: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.suspectedMalicious, true);
  const list = await get(app, '/api/nis2/incidents', 'viewer');
  const ew = list.body[0].deadlines.stages.find((s) => s.stage === 'early-warning');
  assert.equal(ew.status, 'submitted');
  assert.equal(ew.onTime, true);
  assert.equal(list.body[0].deadlines.stages.find((s) => s.stage === 'notification').status, 'overdue');
});

test('PUT without the new fields keeps a recorded submission; an explicit null clears it', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  const app = makeApp({ nis2IncidentsRepo });
  const created = await post(app, '/api/nis2/incidents', 'operator', {
    title: 'A', notificationRequired: true, detectedAt: iso(50), earlyWarningSubmittedAt: iso(40), authorityReference: 'REF-1',
  });
  const id = created.body.id;
  // An older client that knows nothing of migration 122.
  const legacy = await put(app, `/api/nis2/incidents/${id}`, 'operator', { title: 'A (renamed)', notificationRequired: true, detectedAt: iso(50) });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.title, 'A (renamed)');
  assert.ok(legacy.body.earlyWarningSubmittedAt, 'omission did not erase the submission');
  assert.equal(legacy.body.authorityReference, 'REF-1');
  const cleared = await put(app, `/api/nis2/incidents/${id}`, 'operator', { title: 'A', detectedAt: iso(50), earlyWarningSubmittedAt: null });
  assert.equal(cleared.body.earlyWarningSubmittedAt, null);
  assert.equal(cleared.body.authorityReference, 'REF-1');
  // Validation still bites on PUT.
  assert.equal((await put(app, `/api/nis2/incidents/${id}`, 'operator', { title: 'A', notificationSubmittedAt: 'nope' })).status, 400);
});

// --- drafting from an event case -----------------------------------------------------

async function withCase(over = {}) {
  const eventCasesRepo = makeEventCasesRepo({ devices: { 7: { agentName: 'edge-fw-01', locationName: 'Aarhus' } } });
  await eventCasesRepo.create({
    host_id: '7', title: 'Probe reachability lost to 10.0.0.1', severity: 'CRIT', status: 'investigating',
    first_event_at: '2026-06-01T08:00:00.000Z', last_event_at: '2026-06-01T09:30:00.000Z', ...over,
  });
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  return { eventCasesRepo, nis2IncidentsRepo, app: makeApp({ eventCasesRepo, nis2IncidentsRepo }) };
}

test('POST /incidents/from-event-case/:id drafts a linked incident pre-filled from the case', async () => {
  const { app, nis2IncidentsRepo } = await withCase();
  const res = await post(app, '/api/nis2/incidents/from-event-case/1', 'operator', {});
  assert.equal(res.status, 201);
  assert.equal(res.body.title, 'Probe reachability lost to 10.0.0.1');
  assert.equal(res.body.eventCaseId, 1);
  assert.equal(res.body.detectedAt, '2026-06-01T08:00:00.000Z', 'the clock starts at the first event');
  assert.equal(res.body.severity, 'high');
  assert.equal(res.body.nis2Relevant, true);
  assert.equal(res.body.notificationRequired, false, 'significance is a human judgement');
  assert.match(res.body.affectedSystems, /event case #1/);
  assert.match(res.body.affectedSystems, /edge-fw-01 · Aarhus/);
  assert.equal(res.body.deadlines.applicable, true);
  assert.equal(nis2IncidentsRepo.rows.length, 1);
  // An edit never severs the link.
  const edited = await put(app, `/api/nis2/incidents/${res.body.id}`, 'operator', { title: 'Edited' });
  assert.equal(edited.body.eventCaseId, 1);
});

test('409: a case that already has a NIS2 draft names it instead of drafting twice', async () => {
  const { app, nis2IncidentsRepo } = await withCase();
  await post(app, '/api/nis2/incidents/from-event-case/1', 'operator', {});
  const again = await post(app, '/api/nis2/incidents/from-event-case/1', 'operator', {});
  assert.equal(again.status, 409);
  assert.equal(again.body.incident.incidentId, nis2IncidentsRepo.rows[0].incidentId);
  assert.equal(nis2IncidentsRepo.rows.length, 1);
});

test('400 / 401 / 403 / 404 / 500 on the event-case draft', async () => {
  const { app } = await withCase();
  assert.equal((await post(app, '/api/nis2/incidents/from-event-case/abc', 'operator', {})).status, 400);
  assert.equal((await post(app, '/api/nis2/incidents/from-event-case/0', 'operator', {})).status, 400);
  assert.equal((await request(app).post('/api/nis2/incidents/from-event-case/1').send({})).status, 401);
  assert.equal((await post(app, '/api/nis2/incidents/from-event-case/1', 'viewer', {})).status, 403);
  const missing = await post(app, '/api/nis2/incidents/from-event-case/999', 'operator', {});
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /Event case not found/);

  const broken = makeApp({
    eventCasesRepo: makeEventCasesRepo({ findById: throwingAsync('db down') }),
    nis2IncidentsRepo: makeNis2IncidentsRepo(),
  });
  const res = await post(broken, '/api/nis2/incidents/from-event-case/1', 'operator', {});
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!/\.js:\d+/.test(JSON.stringify(res.body)));
});

test('the draft mapping says nothing the case does not know', () => {
  const d = draftFromEventCase({ id: 4, title: '', severity: 'INFO', status: 'resolved', hostId: 'h1', firstEventAt: null, lastEventAt: null, resolvedAt: '2026-06-02T00:00:00.000Z' });
  assert.equal(d.title, 'Event case #4');
  assert.equal(d.severity, 'low');
  assert.equal(d.detectedAt, null);
  assert.equal(d.resolvedAt, '2026-06-02T00:00:00.000Z');
  assert.equal(d.businessImpact, null);
  assert.match(d.affectedSystems, /on h1/);
});
