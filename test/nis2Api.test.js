'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeNis2RisksRepo, makeNis2ControlsRepo, makeNis2IncidentsRepo,
  makeNis2ReportsRepo, makeNis2AuditRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');

const validRisk = {
  title: 'Unpatched VPN gateway', description: 'Internet-facing', category: 'Vulnerability Management',
  affectedAsset: 'vpn-01', likelihood: 4, impact: 5, owner: 'CISO', status: 'open',
  mitigationPlan: 'Patch', dueDate: '2026-07-01', managementAcceptance: false,
};
const validControl = {
  controlName: 'Quarterly access review', nis2Area: 'Access Control', owner: 'IT',
  frequency: 'quarterly', status: 'OK', evidenceFile: 'https://docs/acl-review.pdf',
};
const validIncident = { title: 'Phishing wave', severity: 'high', status: 'investigating', nis2Relevant: true };

// ---- auth + RBAC -----------------------------------------------------------

test('dashboard requires auth (401)', async () => {
  assert.equal((await request(makeApp()).get('/api/nis2/dashboard')).status, 401);
});

test('dashboard returns readiness + metrics (viewer, 200)', async () => {
  const nis2ControlsRepo = makeNis2ControlsRepo();
  await nis2ControlsRepo.create({ controlName: 'c', nis2Area: 'Governance', status: 'OK', evidenceFile: 'x' });
  const res = await request(makeApp({ nis2ControlsRepo })).get('/api/nis2/dashboard').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.readinessScore, 100);
  assert.ok(Array.isArray(res.body.categories) && res.body.categories.length === 10);
  assert.ok(Array.isArray(res.body.topActions));
});

test('creating a risk is forbidden for viewers (403) but allowed for operators (201)', async () => {
  const app = makeApp();
  assert.equal((await request(app).post('/api/nis2/risks').set('Authorization', authHeader('viewer')).send(validRisk)).status, 403);
  const res = await request(app).post('/api/nis2/risks').set('Authorization', authHeader('operator')).send(validRisk);
  assert.equal(res.status, 201);
  assert.equal(res.body.riskScore, 20); // 4 * 5 computed server-side
  assert.equal(res.body.band, 'Critical');
});

// ---- risk register CRUD ----------------------------------------------------

test('risk validation rejects out-of-range likelihood/impact (400)', async () => {
  const res = await request(makeApp()).post('/api/nis2/risks').set('Authorization', authHeader('operator'))
    .send({ ...validRisk, likelihood: 9, impact: 0 });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.likelihood && res.body.details.impact);
});

test('risk validation rejects an unknown category (400)', async () => {
  const res = await request(makeApp()).post('/api/nis2/risks').set('Authorization', authHeader('operator'))
    .send({ ...validRisk, category: 'Not A Category' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.category);
});

test('risk_score recomputes on update', async () => {
  const nis2RisksRepo = makeNis2RisksRepo();
  const app = makeApp({ nis2RisksRepo });
  const created = (await request(app).post('/api/nis2/risks').set('Authorization', authHeader('operator')).send(validRisk)).body;
  const res = await request(app).put(`/api/nis2/risks/${created.id}`).set('Authorization', authHeader('operator'))
    .send({ ...validRisk, likelihood: 1, impact: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.riskScore, 1);
  assert.equal(res.body.band, 'Low');
});

test('GET/PUT/DELETE on an unknown risk id is 404; bad id is 400', async () => {
  const app = makeApp();
  assert.equal((await request(app).get('/api/nis2/risks/999').set('Authorization', authHeader('viewer'))).status, 404);
  assert.equal((await request(app).get('/api/nis2/risks/abc').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app).delete('/api/nis2/risks/999').set('Authorization', authHeader('operator'))).status, 404);
});

test('deleting a risk returns 204 and records an audit entry', async () => {
  const nis2RisksRepo = makeNis2RisksRepo();
  const nis2AuditRepo = makeNis2AuditRepo();
  const app = makeApp({ nis2RisksRepo, nis2AuditRepo });
  const created = (await request(app).post('/api/nis2/risks').set('Authorization', authHeader('operator')).send(validRisk)).body;
  assert.equal((await request(app).delete(`/api/nis2/risks/${created.id}`).set('Authorization', authHeader('operator'))).status, 204);
  // create + delete both audited.
  assert.equal(nis2AuditRepo.rows.filter((r) => r.entityType === 'risk').length, 2);
  assert.ok(nis2AuditRepo.rows.some((r) => r.action === 'delete'));
});

// ---- controls --------------------------------------------------------------

test('controls without evidence are listed via ?withoutEvidence=true', async () => {
  const nis2ControlsRepo = makeNis2ControlsRepo();
  await nis2ControlsRepo.create({ controlName: 'has', nis2Area: 'Governance', status: 'OK', evidenceFile: 'x' });
  await nis2ControlsRepo.create({ controlName: 'missing', nis2Area: 'Governance', status: 'Missing' });
  const res = await request(makeApp({ nis2ControlsRepo })).get('/api/nis2/controls?withoutEvidence=true').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].controlName, 'missing');
});

test('creating a control with an invalid area is 400; valid is 201', async () => {
  const app = makeApp();
  assert.equal((await request(app).post('/api/nis2/controls').set('Authorization', authHeader('operator')).send({ ...validControl, nis2Area: 'Nope' })).status, 400);
  const res = await request(app).post('/api/nis2/controls').set('Authorization', authHeader('operator')).send(validControl);
  assert.equal(res.status, 201);
  assert.equal(res.body.hasEvidence, true);
});

// ---- incidents -------------------------------------------------------------

test('creating an incident mints a reference and audits it', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  const nis2AuditRepo = makeNis2AuditRepo();
  const res = await request(makeApp({ nis2IncidentsRepo, nis2AuditRepo }))
    .post('/api/nis2/incidents').set('Authorization', authHeader('operator')).send(validIncident);
  assert.equal(res.status, 201);
  assert.match(res.body.incidentId, /^INC-\d{4}-\d{4}$/);
  assert.equal(res.body.nis2Relevant, true);
});

test('incident filter by ?nis2Relevant=true works', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  await nis2IncidentsRepo.create({ title: 'a', severity: 'low', status: 'open', nis2Relevant: true });
  await nis2IncidentsRepo.create({ title: 'b', severity: 'low', status: 'open', nis2Relevant: false });
  const res = await request(makeApp({ nis2IncidentsRepo })).get('/api/nis2/incidents?nis2Relevant=true').set('Authorization', authHeader('viewer'));
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].title, 'a');
});

// ---- reports + approval ----------------------------------------------------

test('generating a report stores a draft with a snapshot (operator, 201)', async () => {
  const nis2ReportsRepo = makeNis2ReportsRepo();
  const res = await request(makeApp({ nis2ReportsRepo }))
    .post('/api/nis2/reports').set('Authorization', authHeader('operator')).send({ reportType: 'executive' });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'draft');
  assert.equal(res.body.title, 'NIS2 Executive Report');
  assert.ok(res.body.snapshot && typeof res.body.snapshot.readinessScore === 'number');
});

test('only an admin (compliance) may approve a report', async () => {
  const nis2ReportsRepo = makeNis2ReportsRepo();
  const app = makeApp({ nis2ReportsRepo });
  const rep = (await request(app).post('/api/nis2/reports').set('Authorization', authHeader('operator')).send({ reportType: 'readiness' })).body;
  assert.equal((await request(app).post(`/api/nis2/reports/${rep.id}/approve`).set('Authorization', authHeader('operator'))).status, 403);
  const ok = await request(app).post(`/api/nis2/reports/${rep.id}/approve`).set('Authorization', authHeader('admin'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'approved');
  // Re-approving an already-approved report is 409.
  assert.equal((await request(app).post(`/api/nis2/reports/${rep.id}/approve`).set('Authorization', authHeader('admin'))).status, 409);
});

test('report generation rejects an unknown type (400)', async () => {
  const res = await request(makeApp()).post('/api/nis2/reports').set('Authorization', authHeader('operator')).send({ reportType: 'bogus' });
  assert.equal(res.status, 400);
});

// ---- audit trail -----------------------------------------------------------

test('audit trail is admin-only', async () => {
  const app = makeApp();
  assert.equal((await request(app).get('/api/nis2/audit').set('Authorization', authHeader('operator'))).status, 403);
  assert.equal((await request(app).get('/api/nis2/audit').set('Authorization', authHeader('admin'))).status, 200);
});

// ---- exports ---------------------------------------------------------------

test('CSV export returns text/csv with a header row', async () => {
  const nis2RisksRepo = makeNis2RisksRepo();
  await nis2RisksRepo.create(validRisk);
  const res = await request(makeApp({ nis2RisksRepo })).get('/api/nis2/export/risks.csv').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /nis2-risks\.csv/);
  assert.match(res.text, /^id,title,category/);
});

test('executive HTML export renders a print-ready document', async () => {
  const res = await request(makeApp()).get('/api/nis2/export/executive.html?org=Acme').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /<!DOCTYPE html>/);
  assert.match(res.text, /NIS2 Executive Report/);
  assert.match(res.text, /Acme/);
});

// ---- get-started seed ------------------------------------------------------

test('seed creates one control per category, then refuses if any exist', async () => {
  const nis2ControlsRepo = makeNis2ControlsRepo();
  const app = makeApp({ nis2ControlsRepo });
  const res = await request(app).post('/api/nis2/seed').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 201);
  assert.equal(res.body.created, 10);
  // Second call is a no-op (409) because controls now exist.
  assert.equal((await request(app).post('/api/nis2/seed').set('Authorization', authHeader('operator'))).status, 409);
});

test('seed is forbidden for viewers (403)', async () => {
  assert.equal((await request(makeApp()).post('/api/nis2/seed').set('Authorization', authHeader('viewer'))).status, 403);
});

// ---- Report Generator ------------------------------------------------------

test('custom-report sources hide the audit source from non-admins', async () => {
  const app = makeApp();
  const asViewer = (await request(app).get('/api/nis2/custom-reports/sources').set('Authorization', authHeader('viewer'))).body.sources.map((s) => s.key);
  const asAdmin = (await request(app).get('/api/nis2/custom-reports/sources').set('Authorization', authHeader('admin'))).body.sources.map((s) => s.key);
  assert.ok(!asViewer.includes('audit'));
  assert.ok(asAdmin.includes('audit'));
});

test('custom-report preview builds the requested sections', async () => {
  const nis2RisksRepo = makeNis2RisksRepo();
  await nis2RisksRepo.create(validRisk);
  const res = await request(makeApp({ nis2RisksRepo }))
    .post('/api/nis2/custom-reports/preview').set('Authorization', authHeader('viewer'))
    .send({ title: 'My report', sections: [{ source: 'risks', columns: ['title', 'band'] }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'My report');
  assert.equal(res.body.sections[0].headers.length, 2);
  assert.equal(res.body.sections[0].rows.length, 1);
});

test('custom-report preview rejects an empty/invalid spec (400)', async () => {
  const app = makeApp();
  assert.equal((await request(app).post('/api/nis2/custom-reports/preview').set('Authorization', authHeader('viewer')).send({ sections: [] })).status, 400);
  assert.equal((await request(app).post('/api/nis2/custom-reports/preview').set('Authorization', authHeader('viewer')).send({ sections: [{ source: 'nope' }] })).status, 400);
});

test('custom-report with the audit source is 403 for non-admins', async () => {
  const res = await request(makeApp()).post('/api/nis2/custom-reports/preview').set('Authorization', authHeader('operator'))
    .send({ sections: [{ source: 'audit' }] });
  assert.equal(res.status, 403);
});

test('custom-report export honours the format (csv/json/html)', async () => {
  const nis2RisksRepo = makeNis2RisksRepo();
  await nis2RisksRepo.create(validRisk);
  const app = makeApp({ nis2RisksRepo });
  const spec = (format) => ({ format, sections: [{ source: 'risks', columns: ['title', 'band'] }] });

  const csv = await request(app).post('/api/nis2/custom-reports/export').set('Authorization', authHeader('viewer')).send(spec('csv'));
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /# Risk register/);

  const json = await request(app).post('/api/nis2/custom-reports/export').set('Authorization', authHeader('viewer')).send(spec('json'));
  assert.match(json.headers['content-type'], /application\/json/);
  assert.ok(JSON.parse(json.text).sections.length === 1);

  const html = await request(app).post('/api/nis2/custom-reports/export').set('Authorization', authHeader('viewer')).send(spec('html'));
  assert.match(html.headers['content-type'], /text\/html/);
  assert.match(html.text, /<!DOCTYPE html>/);
});

// ---- error handling --------------------------------------------------------

test('a repository failure surfaces as 500', async () => {
  const nis2RisksRepo = makeNis2RisksRepo({ findAll: throwingAsync('db down') });
  const res = await request(makeApp({ nis2RisksRepo })).get('/api/nis2/risks').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});
