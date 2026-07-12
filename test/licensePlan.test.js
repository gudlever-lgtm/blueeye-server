'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeLicenseManager,
  makeTestPackagesRepo,
  authHeader,
} = require('../test-support/fakes');
const { createPlanService } = require('../src/license/planService');
const { createUsageService } = require('../src/services/usageService');

// Builds an app whose plan/usage services reflect a given plan key + usage.
function appOnPlan(plan, { enabledPaths = 0, createImpl } = {}) {
  // getMaxAgents: 0 → no proof override, so the plan's own max_agents surfaces.
  const licenseManager = makeLicenseManager({ plan, getMaxAgents: () => 0 });
  const planService = createPlanService({ licenseManager });
  const testPackagesRepo = makeTestPackagesRepo({
    findAll: async () => Array.from({ length: enabledPaths }, (_, i) => ({ id: i + 1, enabled: true })),
    ...(createImpl ? { create: createImpl } : {}),
  });
  const usageService = createUsageService({
    agentsRepo: { count: async () => 0 },
    testPackagesRepo,
    planService,
    licenseManager,
  });
  return makeApp({ licenseManager, planService, usageService, testPackagesRepo });
}

test('GET /license/plan returns the active plan summary (viewer+)', async () => {
  const app = appOnPlan('professional');
  const res = await request(app).get('/license/plan').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.plan_key, 'professional');
  assert.equal(res.body.limits.max_agents, 25);
  assert.equal(res.body.features.rbac, true);
  assert.equal(res.body.features.msp_multitenant, undefined); // feature removed
});

test('GET /license/plan shows Starter its mid-tier features (alerts + exports), not the pro-only ones', async () => {
  const app = appOnPlan('starter');
  const res = await request(app).get('/license/plan').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.plan_key, 'starter');
  assert.equal(res.body.features.alerts_email, true);
  assert.equal(res.body.features.reports_pdf, true);
  assert.equal(res.body.features.reports_csv, true);
  assert.equal(res.body.features.rbac, false); // still Professional-only
  assert.equal(res.body.features.sso_oidc, false);
});

test('GET /license/plan requires auth (401)', async () => {
  const app = appOnPlan('starter');
  const res = await request(app).get('/license/plan');
  assert.equal(res.status, 401);
});

test('GET /license/usage reports usage against plan limits', async () => {
  const app = appOnPlan('starter', { enabledPaths: 3 });
  const res = await request(app).get('/license/usage').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.test_paths, { used: 3, max: 25 });
});

test('GET /license/matrix returns the full plan × feature grid', async () => {
  const app = appOnPlan('professional');
  const res = await request(app).get('/license/matrix').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.activePlan, 'professional');
  assert.equal(res.body.plans.length, 3); // pilot/starter/professional (Enterprise + MSP removed)
  assert.ok(!res.body.plans.some((p) => p.plan_key === 'enterprise' || p.plan_key === 'msp'));
  // SSO moved down into Professional (the top tier).
  assert.ok(res.body.features.some((f) => f.key === 'sso_oidc' && f.minPlan === 'professional'));
});

test('legacy GET /license/features is unchanged', async () => {
  const app = appOnPlan('professional');
  const res = await request(app).get('/license/features').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['alerting', 'analysis', 'assistant', 'geo']);
});

test('Starter blocks creating the 26th active test path with a graceful 403', async () => {
  let created = false;
  const app = appOnPlan('starter', { enabledPaths: 25, createImpl: async (p) => { created = true; return { id: 99, ...p }; } });
  const res = await request(app)
    .post('/api/test-packages')
    .set('Authorization', authHeader('operator'))
    .send({ name: 'one too many', enabled: true, schedule_ms: 60000, targets: { mode: 'all' }, items: [{ type: 'run-test' }] });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'plan_limit_reached');
  assert.equal(res.body.limit, 25);
  assert.equal(created, false, 'must not create when over the limit');
});

test('Starter allows a DISABLED test package even at the limit', async () => {
  const app = appOnPlan('starter', { enabledPaths: 25 });
  const res = await request(app)
    .post('/api/test-packages')
    .set('Authorization', authHeader('operator'))
    .send({ name: 'parked', enabled: false, schedule_ms: 0, targets: { mode: 'all' }, items: [{ type: 'run-test' }] });
  assert.equal(res.status, 201);
});

test('an unlimited plan (internal "licensed" fallback) creates test paths without a cap', async () => {
  const app = appOnPlan('licensed', { enabledPaths: 9999 });
  const res = await request(app)
    .post('/api/test-packages')
    .set('Authorization', authHeader('operator'))
    .send({ name: 'fine', enabled: true, schedule_ms: 60000, targets: { mode: 'all' }, items: [{ type: 'run-test' }] });
  assert.equal(res.status, 201);
});
