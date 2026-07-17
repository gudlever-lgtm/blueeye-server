'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeRunbooksRepo, makeRemediationPlaybooksRepo, authHeader } = require('../test-support/fakes');

function appWith(over = {}) {
  const runbooksRepo = over.runbooksRepo || makeRunbooksRepo();
  const remediationPlaybooksRepo = over.remediationPlaybooksRepo || makeRemediationPlaybooksRepo();
  const app = makeApp({ runbooksRepo, remediationPlaybooksRepo });
  return { app, runbooksRepo, remediationPlaybooksRepo };
}

const VALID = { findingType: 'cpu', title: 'High CPU', bodyMarkdown: '# Fix\nRestart the service.' };

// ---- list / read -----------------------------------------------------------

test('GET /api/runbooks lists (viewer+) → 200', async () => {
  const { app, runbooksRepo } = appWith();
  await runbooksRepo.create({ findingType: 'cpu', title: 'A', bodyMarkdown: 'x' });
  const res = await request(app).get('/api/runbooks').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.runbooks.length, 1);
});

test('GET /api/runbooks requires auth → 401', async () => {
  const { app } = appWith();
  assert.equal((await request(app).get('/api/runbooks')).status, 401);
});

test('GET /api/runbooks/:id is 404 for unknown', async () => {
  const { app } = appWith();
  const res = await request(app).get('/api/runbooks/999').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /api/runbooks returns a clean 500 on repo failure (no stack leak)', async () => {
  const { app } = appWith({ runbooksRepo: makeRunbooksRepo({ list: async () => { throw new Error('db kaboom'); } }) });
  const res = await request(app).get('/api/runbooks').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!/kaboom/.test(String(res.body.error)));
});

// ---- create (admin) --------------------------------------------------------

test('POST /api/runbooks creates (admin) → 201', async () => {
  const { app, runbooksRepo } = appWith();
  const res = await request(app).post('/api/runbooks').set('Authorization', authHeader('admin')).send(VALID);
  assert.equal(res.status, 201);
  assert.equal(res.body.runbook.findingType, 'cpu');
  assert.equal(runbooksRepo.rows.length, 1);
});

test('POST /api/runbooks is 403 for operator (admin-only write)', async () => {
  const { app } = appWith();
  const res = await request(app).post('/api/runbooks').set('Authorization', authHeader('operator')).send(VALID);
  assert.equal(res.status, 403);
});

test('POST /api/runbooks is 401 without auth', async () => {
  const { app } = appWith();
  assert.equal((await request(app).post('/api/runbooks').send(VALID)).status, 401);
});

test('POST /api/runbooks 400 on missing fields', async () => {
  const { app } = appWith();
  const res = await request(app).post('/api/runbooks').set('Authorization', authHeader('admin')).send({ findingType: '', title: '', bodyMarkdown: '' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.findingType && res.body.details.title && res.body.details.bodyMarkdown);
});

test('POST /api/runbooks 400 when linkedPlaybookId does not exist', async () => {
  const { app } = appWith();
  const res = await request(app).post('/api/runbooks').set('Authorization', authHeader('admin')).send({ ...VALID, linkedPlaybookId: 4242 });
  assert.equal(res.status, 400);
  assert.match(res.body.details.linkedPlaybookId, /existing playbook/);
});

test('POST /api/runbooks accepts a valid linkedPlaybookId', async () => {
  const remediationPlaybooksRepo = makeRemediationPlaybooksRepo();
  const pbId = await remediationPlaybooksRepo.create({ name: 'Restart', trigger_condition: 'cpu', action_type: 'restart_service' });
  const { app } = appWith({ remediationPlaybooksRepo });
  const res = await request(app).post('/api/runbooks').set('Authorization', authHeader('admin')).send({ ...VALID, linkedPlaybookId: pbId });
  assert.equal(res.status, 201);
  assert.equal(res.body.runbook.linkedPlaybookId, pbId);
});

// ---- update / delete (admin) ----------------------------------------------

test('PUT /api/runbooks/:id updates (admin)', async () => {
  const { app, runbooksRepo } = appWith();
  const id = await runbooksRepo.create({ findingType: 'cpu', title: 'Old', bodyMarkdown: 'x' });
  const res = await request(app).put(`/api/runbooks/${id}`).set('Authorization', authHeader('admin')).send({ ...VALID, title: 'New' });
  assert.equal(res.status, 200);
  assert.equal(res.body.runbook.title, 'New');
});

test('PUT /api/runbooks/:id is 404 for unknown', async () => {
  const { app } = appWith();
  const res = await request(app).put('/api/runbooks/999').set('Authorization', authHeader('admin')).send(VALID);
  assert.equal(res.status, 404);
});

test('DELETE /api/runbooks/:id removes (admin) → 204', async () => {
  const { app, runbooksRepo } = appWith();
  const id = await runbooksRepo.create({ findingType: 'cpu', title: 'A', bodyMarkdown: 'x' });
  const res = await request(app).delete(`/api/runbooks/${id}`).set('Authorization', authHeader('admin'));
  assert.equal(res.status, 204);
  assert.equal(runbooksRepo.rows.length, 0);
});

test('DELETE /api/runbooks/:id is 403 for operator', async () => {
  const { app, runbooksRepo } = appWith();
  const id = await runbooksRepo.create({ findingType: 'cpu', title: 'A', bodyMarkdown: 'x' });
  const res = await request(app).delete(`/api/runbooks/${id}`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 403);
});

test('GET /api/runbooks/playbooks lists playbooks for the link editor (admin)', async () => {
  const remediationPlaybooksRepo = makeRemediationPlaybooksRepo();
  await remediationPlaybooksRepo.create({ name: 'Restart', trigger_condition: 'cpu', action_type: 'restart_service' });
  const { app } = appWith({ remediationPlaybooksRepo });
  const res = await request(app).get('/api/runbooks/playbooks').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.playbooks[0].name, 'Restart');
});
