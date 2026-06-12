'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlanService } = require('../planService');
const { createFeatureGate, requirePlanFeature } = require('../features');
const { createUsageService } = require('../../services/usageService');
const { PLANS, PLAN_ORDER, ALL_FEATURE_KEYS } = require('../plans');

// A minimal license-manager stub: licensed, carrying a given plan key, with an
// optional proof max_agents override and legacy module feature map.
function lm({ licensed = true, plan = '', maxAgents = 0, features = {} } = {}) {
  return {
    isLicensed: () => licensed,
    getPlan: () => plan,
    getMaxAgents: () => maxAgents,
    getFeatures: () => features,
    getStatus: () => ({ verifiedAt: '2026-06-01T00:00:00.000Z' }),
  };
}

// ---- Plan resolution + limits --------------------------------------------

test('resolves the plan from the signed proof plan field', () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'professional' }) });
  assert.equal(ps.getPlanKey(), 'professional');
  assert.equal(ps.getCurrentPlan().plan_name, 'Professional');
});

test('falls back to LICENSE_PLAN config when the proof carries no plan', () => {
  const ps = createPlanService({ licenseManager: lm({ plan: '' }), configPlan: 'starter' });
  assert.equal(ps.getPlanKey(), 'starter');
});

test('licensed-but-no-plan keeps legacy behaviour (internal "licensed", unlimited)', () => {
  const ps = createPlanService({ licenseManager: lm({ plan: '' }) });
  assert.equal(ps.getPlanKey(), 'licensed');
  assert.equal(ps.getPlanLimit('max_test_paths'), null); // unlimited
});

test('unlicensed falls back to the locked-down "unlicensed" plan', () => {
  const ps = createPlanService({ licenseManager: lm({ licensed: false }) });
  assert.equal(ps.getPlanKey(), 'unlicensed');
  assert.equal(ps.getPlanLimit('max_agents'), 0);
  assert.equal(ps.getPlanLimit('max_test_paths'), 0);
});

test('max_agents honours the signed proof override over the plan default', () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'professional', maxAgents: 7 }) });
  assert.equal(ps.getPlanLimit('max_agents'), 7); // proof wins over plan's 25
});

test('plan limits match the catalogue (Starter / Enterprise)', () => {
  const starter = createPlanService({ licenseManager: lm({ plan: 'starter' }) });
  assert.equal(starter.getPlanLimit('max_agents'), 5);
  assert.equal(starter.getPlanLimit('max_test_paths'), 25);
  assert.equal(starter.getPlanLimit('history_days'), 90);

  const ent = createPlanService({ licenseManager: lm({ plan: 'enterprise' }) });
  assert.equal(ent.getPlanLimit('max_agents'), null); // unlimited / configurable
  assert.equal(ent.getPlanLimit('history_days'), 1095);
});

// ---- Q10: FeatureGate returns correct true/false per plan -----------------

test('Q10: every plan grants exactly its catalogued features and nothing more', () => {
  for (const key of PLAN_ORDER) {
    const ps = createPlanService({ licenseManager: lm({ plan: key }) });
    const allowed = new Set(PLANS[key].allowed_features);
    for (const f of ALL_FEATURE_KEYS) {
      assert.equal(ps.hasFeature(f), allowed.has(f), `${key} → ${f}`);
    }
  }
});

test('Q3/Q4: Professional grants PDF/CSV/SLA reports + RBAC + audit + API', () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'professional' }) });
  for (const f of ['reports_pdf', 'reports_csv', 'reports_sla', 'rbac', 'audit_log', 'api_access']) {
    assert.equal(ps.hasFeature(f), true, f);
  }
  // …but NOT the Enterprise-only ones.
  for (const f of ['sso_oidc', 'sso_saml', 'reports_compliance']) {
    assert.equal(ps.hasFeature(f), false, f);
  }
});

test('Q5: Enterprise grants SSO + compliance reports', () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'enterprise' }) });
  for (const f of ['sso_oidc', 'sso_saml', 'reports_compliance', 'ha_deployment', 'offline_license']) {
    assert.equal(ps.hasFeature(f), true, f);
  }
  assert.equal(ps.isEnterprise(), true);
});

test('multi-tenancy is gone: msp_multitenant is no longer a known feature key', () => {
  for (const key of ['pilot', 'starter', 'professional', 'enterprise']) {
    const ps = createPlanService({ licenseManager: lm({ plan: key }) });
    assert.equal(ps.hasFeature('msp_multitenant'), false, key);
    assert.equal(ps.getFeatures().msp_multitenant, undefined, key);
  }
  // The removed plan key resolves to the locked-down fallback, not a real plan.
  const removed = createPlanService({ licenseManager: lm({ plan: 'msp' }) });
  assert.equal(removed.getPlanKey(), 'licensed'); // unknown sellable key → safe fallback
});

test('Q8: an expired pilot (unlicensed) grants no packaged features', () => {
  const ps = createPlanService({ licenseManager: lm({ licensed: false }) });
  for (const f of ALL_FEATURE_KEYS) assert.equal(ps.hasFeature(f), false, f);
});

// ---- Feature gate integration (legacy OR plan) ----------------------------

test('feature gate ORs the legacy proof map with plan features (never removes access)', () => {
  // Legacy proof grants the four modules but NO plan; plan adds the new keys.
  const manager = lm({ plan: 'professional', features: { analysis: true, geo: true } });
  const ps = createPlanService({ licenseManager: manager });
  const gate = createFeatureGate({ licenseManager: manager, planService: ps });

  assert.equal(gate.isFeatureEnabled('analysis'), true); // legacy still works
  assert.equal(gate.isFeatureEnabled('geo'), true);
  assert.equal(gate.isFeatureEnabled('rbac'), true); // plan adds it
  assert.equal(gate.isFeatureEnabled('msp_multitenant'), false); // removed key never enabled
  // The legacy summary shape is untouched.
  assert.deepEqual(gate.summary(), { analysis: true, assistant: false, alerting: false, geo: true });
});

test('moduleRequirements maps each legacy module to the package it is sold under', () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'pilot' }) });
  const mods = ps.moduleRequirements();
  assert.deepEqual(mods.geo, {
    required_plan: 'professional',
    required_plan_name: 'Professional',
    required_plan_label: 'BlueEye Professional',
  });
  assert.equal(mods.analysis.required_plan_name, 'Professional');
  assert.equal(mods.assistant.required_plan_label, 'BlueEye Enterprise');
  // Exposed on the UI summary too.
  assert.deepEqual(ps.summary().modules, mods);
});

test('module tiering is display-only — a plan key never GRANTS a legacy module', () => {
  // Professional plan, but the signed proof carries NO module features: the gate
  // must still deny geo/analysis (no licence bypass via the plan/MODULE_PLAN_TIER).
  const manager = lm({ plan: 'professional', features: {} });
  const ps = createPlanService({ licenseManager: manager });
  const gate = createFeatureGate({ licenseManager: manager, planService: ps });
  assert.equal(gate.isFeatureEnabled('geo'), false);
  assert.equal(gate.isFeatureEnabled('analysis'), false);
  assert.equal(ps.hasFeature('geo'), false);
});

test('upgradeHint names the required BlueEye plan', () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'starter' }) });
  assert.equal(ps.upgradeHint('api_access'), 'This feature requires BlueEye Professional.');
  assert.equal(ps.upgradeHint('sso_oidc'), 'This feature requires BlueEye Enterprise.');
  assert.equal(ps.upgradeHint('msp_multitenant'), null); // removed key → no hint
  assert.equal(ps.upgradeHint('reports_basic'), null); // already entitled
});

test('requirePlanFeature returns the documented 403 contract on denial', () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'starter' }) });
  const gate = createFeatureGate({ licenseManager: lm({ plan: 'starter' }), planService: ps });
  const mw = requirePlanFeature({ featureGate: gate, planService: ps }, 'reports_compliance');

  let status = 0;
  let body = null;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; } };
  let nexted = false;
  mw({}, res, () => { nexted = true; });

  assert.equal(nexted, false);
  assert.equal(status, 403);
  assert.deepEqual(body, {
    success: false,
    error: 'feature_not_available',
    feature: 'reports_compliance',
    message: 'This feature requires BlueEye Enterprise.',
  });
});

test('requirePlanFeature calls next() when entitled', () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'enterprise' }) });
  const gate = createFeatureGate({ licenseManager: lm({ plan: 'enterprise' }), planService: ps });
  const mw = requirePlanFeature({ featureGate: gate, planService: ps }, 'reports_compliance');
  let nexted = false;
  mw({}, { status() { return this; }, json() {} }, () => { nexted = true; });
  assert.equal(nexted, true);
});

// ---- Usage service (limits) ----------------------------------------------

function repos({ agents = 0, enabledPaths = 0 } = {}) {
  return {
    agentsRepo: { count: async () => agents },
    testPackagesRepo: {
      findAll: async () => Array.from({ length: enabledPaths }, (_, i) => ({ id: i + 1, enabled: true })),
    },
  };
}

test('Q1: Starter blocks the 6th agent with a graceful message', async () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'starter' }) });
  const { agentsRepo, testPackagesRepo } = repos({ agents: 5 });
  const usage = createUsageService({ agentsRepo, testPackagesRepo, planService: ps });

  const check = await usage.assertWithinLimit('agents');
  assert.equal(check.ok, false);
  assert.equal(check.body.error, 'plan_limit_reached');
  assert.equal(check.body.limit, 5);
  assert.match(check.body.message, /Starter/);
  assert.match(check.body.message, /up to 5 agents/);
});

test('Starter allows the 5th agent (under the limit)', async () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'starter' }) });
  const { agentsRepo, testPackagesRepo } = repos({ agents: 4 });
  const usage = createUsageService({ agentsRepo, testPackagesRepo, planService: ps });
  assert.equal((await usage.assertWithinLimit('agents')).ok, true);
});

test('Starter caps active test paths at 25', async () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'starter' }) });
  const { agentsRepo, testPackagesRepo } = repos({ enabledPaths: 25 });
  const usage = createUsageService({ agentsRepo, testPackagesRepo, planService: ps });
  const check = await usage.assertWithinLimit('test_paths');
  assert.equal(check.ok, false);
  assert.equal(check.body.resource, 'test_paths');
  assert.equal(check.body.limit, 25);
});

test('Enterprise (unlimited) never trips a limit', async () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'enterprise' }) });
  const { agentsRepo, testPackagesRepo } = repos({ agents: 9999, enabledPaths: 9999 });
  const usage = createUsageService({ agentsRepo, testPackagesRepo, planService: ps });
  assert.equal((await usage.assertWithinLimit('agents')).ok, true);
  assert.equal((await usage.assertWithinLimit('test_paths')).ok, true);
});

test('usage limits fail closed without a plan service (or for unknown resources)', async () => {
  const { agentsRepo, testPackagesRepo } = repos({ agents: 0, enabledPaths: 0 });
  // No planService wired: a misconfiguration must deny, never lift quotas.
  const usage = createUsageService({ agentsRepo, testPackagesRepo });
  assert.equal((await usage.assertWithinLimit('agents')).ok, false);
  assert.equal(await usage.isLimitReached('agents'), true);

  // Unknown resource types deny too, even with a plan service present.
  const ps = createPlanService({ licenseManager: lm({ plan: 'enterprise' }) });
  const withPlan = createUsageService({ agentsRepo, testPackagesRepo, planService: ps });
  assert.equal((await withPlan.assertWithinLimit('nonsense')).ok, false);
});

test('getUsage reports used + max for the active plan', async () => {
  const ps = createPlanService({ licenseManager: lm({ plan: 'professional' }) });
  const { agentsRepo, testPackagesRepo } = repos({ agents: 3, enabledPaths: 10 });
  const usage = createUsageService({ agentsRepo, testPackagesRepo, planService: ps, licenseManager: lm({ plan: 'professional' }) });
  const u = await usage.getUsage();
  assert.deepEqual(u.agents, { used: 3, max: 25 });
  assert.deepEqual(u.test_paths, { used: 10, max: 150 });
  assert.equal(u.history_days, 365);
  assert.equal(u.plan, 'professional');
});
