'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeResultsRepo, makeSettingsService, authHeader,
} = require('../test-support/fakes');

// ---- settings service: get / set / validate / reset -----------------------

test('getFlowCategories returns the built-in defaults when nothing is stored', async () => {
  const svc = makeSettingsService();
  const cats = await svc.getFlowCategories();
  assert.ok(Array.isArray(cats) && cats.length > 5);
  assert.ok(cats.some((c) => c.id === 'dns' && c.kind === 'port'));
  assert.ok(cats.some((c) => c.id === 'facebook' && c.kind === 'asn'));
});

test('setFlowCategories normalises (dedupes numbers) and persists', async () => {
  const svc = makeSettingsService();
  const stored = await svc.setFlowCategories([{ id: 'gaming', label: 'Gaming', kind: 'port', ports: [9999, 9999, 80] }]);
  assert.deepEqual(stored, [{ id: 'gaming', label: 'Gaming', kind: 'port', ports: [9999, 80] }]);
  const got = await svc.getFlowCategories();
  assert.equal(got.length, 1);
  assert.equal(got[0].id, 'gaming');
});

test('resetFlowCategories restores the defaults', async () => {
  const svc = makeSettingsService();
  await svc.setFlowCategories([{ id: 'x', label: 'X', kind: 'asn', asns: [1] }]);
  const defaults = await svc.resetFlowCategories();
  assert.ok(defaults.length > 5);
  const after = await svc.getFlowCategories();
  assert.ok(after.some((c) => c.id === 'dns'));
});

test('setFlowCategories rejects invalid input', async () => {
  const svc = makeSettingsService();
  await assert.rejects(() => svc.setFlowCategories('nope'), (e) => e.statusCode === 400);
  await assert.rejects(() => svc.setFlowCategories([{ id: 'a', label: 'A', kind: 'bogus', ports: [1] }]), (e) => e.statusCode === 400);
  await assert.rejects(() => svc.setFlowCategories([{ id: 'a', label: 'A', kind: 'port', ports: [] }]), (e) => e.statusCode === 400);
  await assert.rejects(() => svc.setFlowCategories([{ id: 'a', label: 'A', kind: 'port', ports: [70000] }]), (e) => e.statusCode === 400);
  await assert.rejects(() => svc.setFlowCategories([
    { id: 'dup', label: 'A', kind: 'port', ports: [1] },
    { id: 'dup', label: 'B', kind: 'port', ports: [2] },
  ]), (e) => e.statusCode === 400);
});

// ---- settings router ------------------------------------------------------

test('PUT /api/settings/flow-categories saves (admin) and GET reflects it', async () => {
  const settingsService = makeSettingsService();
  const app = makeApp({ settingsService });
  const put = await request(app).put('/api/settings/flow-categories')
    .set('Authorization', authHeader('admin'))
    .send({ categories: [{ id: 'gaming', label: 'Gaming', kind: 'port', ports: [9999] }] });
  assert.equal(put.status, 200);
  assert.equal(put.body.flowCategories.length, 1);

  const get = await request(app).get('/api/settings').set('Authorization', authHeader('admin'));
  assert.equal(get.status, 200);
  assert.deepEqual(get.body.flowCategories, [{ id: 'gaming', label: 'Gaming', kind: 'port', ports: [9999] }]);
});

test('PUT /api/settings/flow-categories with reset restores defaults', async () => {
  const settingsService = makeSettingsService();
  const app = makeApp({ settingsService });
  await request(app).put('/api/settings/flow-categories').set('Authorization', authHeader('admin')).send({ categories: [{ id: 'x', label: 'X', kind: 'asn', asns: [1] }] });
  const res = await request(app).put('/api/settings/flow-categories').set('Authorization', authHeader('admin')).send({ reset: true });
  assert.equal(res.status, 200);
  assert.ok(res.body.flowCategories.length > 5);
});

test('PUT /api/settings/flow-categories validates (400)', async () => {
  const res = await request(makeApp()).put('/api/settings/flow-categories')
    .set('Authorization', authHeader('admin'))
    .send({ categories: [{ id: 'a', label: 'A', kind: 'nope' }] });
  assert.equal(res.status, 400);
  assert.ok(res.body.details);
});

test('PUT /api/settings/flow-categories is admin-only (403 for viewer)', async () => {
  const res = await request(makeApp()).put('/api/settings/flow-categories')
    .set('Authorization', authHeader('viewer'))
    .send({ categories: [] });
  assert.equal(res.status, 403);
});

// ---- flows route honours the edited categories ----------------------------

test('GET /api/flows/categories uses the admin-edited category list', async () => {
  const settingsService = makeSettingsService({ initial: { flowCategories: [{ id: 'gaming', label: 'Gaming', kind: 'port', ports: [9999] }] } });
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h1' }) });
  const resultsRepo = makeResultsRepo({
    findByAgentId: async () => [{
      created_at: new Date('2026-06-01T00:05:00.000Z'),
      payload: { traffic: { byPort: [{ port: 9999, bytes: 1234 }, { port: 53, bytes: 500 }] } },
    }],
  });
  const app = makeApp({ settingsService, agentsRepo, resultsRepo });
  const res = await request(app)
    .get('/api/flows/categories?agentId=1&from=2026-06-01T00:00:00.000Z&to=2026-06-01T01:00:00.000Z')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const ids = res.body.categories.map((c) => c.id);
  assert.ok(ids.includes('gaming'));   // custom category matched port 9999
  assert.ok(!ids.includes('dns'));     // defaults were replaced, so 53 is unclassified
  assert.equal(res.body.categories.find((c) => c.id === 'gaming').total, 1234);
});
