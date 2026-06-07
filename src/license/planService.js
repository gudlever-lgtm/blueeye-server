'use strict';

const {
  PLANS,
  PLAN_ORDER,
  FEATURE_CATALOG,
  ALL_FEATURE_KEYS,
  getPlan,
  planDisplayName,
} = require('./plans');

// Resolves the customer's ACTIVE plan and answers questions about it:
//   getCurrentPlan(), getPlanKey(), getPlanLimit(key),
//   hasFeature(key), getFeatures(), featureMatrix(), upgradeHint(key).
//
// Plan resolution (in priority order):
//   1. The `plan` field on the signature-verified license proof
//      (licenseManager.getPlan()).
//   2. A locally-configured plan (LICENSE_PLAN env → config.license.plan),
//      for on-prem installs that set the package without a full proof.
//   3. Safe fallback: 'licensed' when a valid proof exists but carries no plan
//      (preserves legacy behaviour — unlimited plan limits, no new features),
//      otherwise 'unlicensed' (locked down).
//
// This layer is ADDITIVE to the existing license manager: agent limits and the
// legacy analysis/assistant/alerting/geo entitlements keep flowing from the
// signed proof. The plan only adds the new packaged feature keys and the
// test-path / history limits.
function createPlanService({ licenseManager = null, configPlan = '' } = {}) {
  function isLicensed() {
    return Boolean(
      licenseManager && typeof licenseManager.isLicensed === 'function' && licenseManager.isLicensed()
    );
  }

  function getPlanKey() {
    let key = '';
    if (licenseManager && typeof licenseManager.getPlan === 'function') {
      key = licenseManager.getPlan() || '';
    }
    if (!key && configPlan) key = configPlan;
    if (!getPlan(key)) {
      // Unknown / absent — fall back safely.
      key = isLicensed() ? 'licensed' : 'unlicensed';
    }
    return key;
  }

  function getCurrentPlan() {
    return getPlan(getPlanKey()) || getPlan('unlicensed');
  }

  // A plan limit. `max_agents` honours the signed proof's own limit when present
  // (so an Enterprise per-customer cap still wins); `null` means unlimited.
  function getPlanLimit(limitKey) {
    const plan = getCurrentPlan();
    if (limitKey === 'max_agents') {
      const proofMax =
        licenseManager && typeof licenseManager.getMaxAgents === 'function'
          ? licenseManager.getMaxAgents()
          : 0;
      if (Number.isInteger(proofMax) && proofMax > 0) return proofMax;
      return plan.max_agents; // may be null (unlimited)
    }
    if (limitKey === 'max_test_paths') {
      // An offline license may carry a per-license test-path override; the online
      // manager has no such field, so this is backward-compatible.
      const proofMax =
        licenseManager && typeof licenseManager.getMaxTestPaths === 'function'
          ? licenseManager.getMaxTestPaths()
          : 0;
      if (Number.isInteger(proofMax) && proofMax > 0) return proofMax;
      return plan.max_test_paths;
    }
    if (limitKey === 'history_days') return plan.history_days;
    return undefined;
  }

  // The set of feature keys the ACTIVE plan grants (new packaged keys only).
  function planFeatureSet() {
    const plan = getCurrentPlan();
    return new Set(plan.allowed_features || []);
  }

  // True if the plan grants this packaged feature. (The feature gate ORs this
  // with the legacy proof feature map, so it never overrides existing access.)
  function hasFeature(featureKey) {
    return planFeatureSet().has(featureKey);
  }

  // { feature: boolean } for every known packaged feature key — drives the UI
  // feature matrix and the /license/matrix endpoint.
  function getFeatures() {
    const set = planFeatureSet();
    const out = {};
    for (const key of ALL_FEATURE_KEYS) out[key] = set.has(key);
    return out;
  }

  // A user-facing upgrade hint for a feature the active plan lacks, e.g.
  // "This feature requires BlueEye Professional." Returns null when already
  // entitled.
  function upgradeHint(featureKey) {
    if (hasFeature(featureKey)) return null;
    const meta = FEATURE_CATALOG[featureKey];
    if (!meta) return null;
    return `This feature requires ${planDisplayName(meta.minPlan)}.`;
  }

  function isMsp() {
    return Boolean(getCurrentPlan().is_msp);
  }

  function isEnterprise() {
    return Boolean(getCurrentPlan().is_enterprise);
  }

  // A compact, UI-ready summary of the active plan + its features + limits.
  function summary() {
    const plan = getCurrentPlan();
    return {
      plan_key: plan.plan_key,
      plan_name: plan.plan_name,
      support_level: plan.support_level,
      is_trial: !!plan.is_trial,
      is_msp: !!plan.is_msp,
      is_enterprise: !!plan.is_enterprise,
      limits: {
        max_agents: getPlanLimit('max_agents'),
        max_test_paths: getPlanLimit('max_test_paths'),
        history_days: getPlanLimit('history_days'),
      },
      features: getFeatures(),
      price_reference_eur: plan.price_reference_eur,
      price_reference_dkk: plan.price_reference_dkk,
      price_from: !!plan.price_from,
    };
  }

  // The full sellable-plan × feature grid, for the admin "feature matrix" view.
  function featureMatrix() {
    const plans = PLAN_ORDER.map((key) => {
      const p = PLANS[key];
      const set = new Set(p.allowed_features || []);
      const features = {};
      for (const f of ALL_FEATURE_KEYS) features[f] = set.has(f);
      return {
        plan_key: p.plan_key,
        plan_name: p.plan_name,
        max_agents: p.max_agents,
        max_test_paths: p.max_test_paths,
        history_days: p.history_days,
        support_level: p.support_level,
        price_reference_eur: p.price_reference_eur,
        price_reference_dkk: p.price_reference_dkk,
        price_from: !!p.price_from,
        features,
      };
    });
    const featureList = ALL_FEATURE_KEYS.map((key) => ({
      key,
      label: FEATURE_CATALOG[key].label,
      minPlan: FEATURE_CATALOG[key].minPlan,
    }));
    return { activePlan: getPlanKey(), plans, features: featureList };
  }

  return {
    getPlanKey,
    getCurrentPlan,
    getPlanLimit,
    hasFeature,
    getFeatures,
    upgradeHint,
    isMsp,
    isEnterprise,
    summary,
    featureMatrix,
  };
}

module.exports = { createPlanService };
