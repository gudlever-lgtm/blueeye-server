'use strict';

// Tracks resource usage against the active plan's limits and answers the
// "may I create one more?" question at the point of creation/activation.
//
//   const usage = createUsageService({ agentsRepo, testPackagesRepo, planService });
//   const check = await usage.assertWithinLimit('test_paths'); // adding 1 by default
//   if (!check.ok) return res.status(403).json(check.body);    // graceful 403
//
// `body` is the documented denial contract: { success:false, error, message,
// resource, limit, used }. Messages are plain, human and never leak internals.
//
// A `null` limit means unlimited (Enterprise / MSP) — always within limit.
function createUsageService({
  agentsRepo = null,
  testPackagesRepo = null,
  planService = null,
  licenseManager = null,
} = {}) {
  async function countAgents() {
    if (agentsRepo && typeof agentsRepo.count === 'function') {
      const n = await agentsRepo.count();
      return Number.isInteger(n) ? n : 0;
    }
    if (agentsRepo && typeof agentsRepo.findAll === 'function') {
      const rows = await agentsRepo.findAll();
      return Array.isArray(rows) ? rows.length : 0;
    }
    return 0;
  }

  // "Active test paths" = enabled test packages (the ones that actually run).
  async function countActiveTestPaths() {
    if (!testPackagesRepo || typeof testPackagesRepo.findAll !== 'function') return 0;
    const rows = await testPackagesRepo.findAll();
    if (!Array.isArray(rows)) return 0;
    return rows.filter((p) => p && p.enabled).length;
  }

  function planName() {
    if (planService && typeof planService.getCurrentPlan === 'function') {
      return planService.getCurrentPlan().plan_name;
    }
    return 'BlueEye';
  }

  function limitFor(resourceType) {
    if (!planService || typeof planService.getPlanLimit !== 'function') return null;
    if (resourceType === 'agents') return planService.getPlanLimit('max_agents');
    if (resourceType === 'test_paths') return planService.getPlanLimit('max_test_paths');
    return null;
  }

  async function usedFor(resourceType) {
    if (resourceType === 'agents') return countAgents();
    if (resourceType === 'test_paths') return countActiveTestPaths();
    return 0;
  }

  // A full usage snapshot for the admin "Usage overview" panel.
  async function getUsage() {
    const [agents, testPaths] = await Promise.all([countAgents(), countActiveTestPaths()]);
    const lastValidation =
      licenseManager && typeof licenseManager.getStatus === 'function'
        ? licenseManager.getStatus().verifiedAt
        : null;
    return {
      agents: { used: agents, max: limitFor('agents') },
      test_paths: { used: testPaths, max: limitFor('test_paths') },
      history_days:
        planService && typeof planService.getPlanLimit === 'function'
          ? planService.getPlanLimit('history_days')
          : null,
      plan: planService && typeof planService.getCurrentPlan === 'function'
        ? planService.getCurrentPlan().plan_key
        : null,
      lastValidation,
    };
  }

  // True when creating `adding` more of `resourceType` would exceed the limit.
  async function isLimitReached(resourceType, { adding = 1 } = {}) {
    const limit = limitFor(resourceType);
    if (limit === null || limit === undefined) return false; // unlimited
    const used = await usedFor(resourceType);
    return used + adding > limit;
  }

  // Resolves to { ok:true } or { ok:false, body } where body is the 403 payload.
  async function assertWithinLimit(resourceType, { adding = 1 } = {}) {
    const limit = limitFor(resourceType);
    if (limit === null || limit === undefined) return { ok: true };
    const used = await usedFor(resourceType);
    if (used + adding <= limit) return { ok: true };

    const noun = resourceType === 'agents' ? 'agents' : 'active test paths';
    return {
      ok: false,
      body: {
        success: false,
        error: 'plan_limit_reached',
        resource: resourceType,
        limit,
        used,
        message:
          `Your current BlueEye ${planName()} licence allows up to ${limit} ${noun}. ` +
          'Contact your administrator or upgrade the licence to add more.',
      },
    };
  }

  return {
    getUsage,
    isLimitReached,
    assertWithinLimit,
    countAgents,
    countActiveTestPaths,
  };
}

module.exports = { createUsageService };
