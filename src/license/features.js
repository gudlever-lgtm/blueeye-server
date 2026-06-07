'use strict';

// The modules that can be license-gated. Kept here so the /features endpoint
// and the UI agree on the set.
const KNOWN_FEATURES = ['analysis', 'assistant', 'alerting', 'geo'];

// Reads feature entitlements from the already-validated, signature-verified
// license (via the license manager). FAIL-CLOSED: anything not explicitly
// `true` — a missing field, a non-object features map, or no valid license —
// means the feature is NOT allowed. The license manager caches the parsed
// license and refreshes it on renewal, so this always reflects the latest proof.
//
//   const gate = createFeatureGate({ licenseManager });
//   gate.isFeatureEnabled('geo'); // true only if the license grants it
//
// An optional `planService` extends the gate with the packaged plan feature
// keys (rbac, reports_pdf, api_access, …). It is ADDITIVE and OR-ed in: the
// legacy proof feature map (analysis/assistant/alerting/geo) still governs those
// four exactly as before, so passing a planService never removes access.
function createFeatureGate({ licenseManager, planService = null } = {}) {
  function features() {
    if (!licenseManager || typeof licenseManager.getFeatures !== 'function') return {};
    const f = licenseManager.getFeatures();
    return f && typeof f === 'object' ? f : {};
  }

  function isFeatureEnabled(feature) {
    if (features()[feature] === true) return true;
    if (planService && typeof planService.hasFeature === 'function') {
      return planService.hasFeature(feature) === true;
    }
    return false;
  }

  // { analysis, assistant, alerting, geo } booleans for the UI.
  function summary() {
    const out = {};
    for (const name of KNOWN_FEATURES) out[name] = isFeatureEnabled(name);
    return out;
  }

  return { isFeatureEnabled, summary };
}

// Express middleware that returns 403 with a license-specific message when the
// feature isn't included in the license. The message is deliberately distinct
// from a "feature switched off in config" response so the UI/operator can tell
// the two apart.
function requireFeature(featureGate, feature) {
  return (req, res, next) => {
    if (featureGate && featureGate.isFeatureEnabled(feature)) return next();
    return res.status(403).json({
      error: 'This feature is not included in your license',
      feature,
      reason: 'license',
    });
  };
}

// Express middleware for the NEW packaged feature keys (api_access,
// reports_compliance, msp_multitenant, …). On denial it returns the documented
// contract — HTTP 403 with { success, error, message } — and a precise upgrade
// hint derived from the active plan ("This feature requires BlueEye Enterprise").
// Kept distinct from requireFeature() so the four legacy module endpoints keep
// their existing 403 shape untouched.
function requirePlanFeature(deps, feature) {
  const featureGate = deps && deps.featureGate;
  const planService = deps && deps.planService;
  return (req, res, next) => {
    if (featureGate && featureGate.isFeatureEnabled(feature)) return next();
    const hint =
      (planService && typeof planService.upgradeHint === 'function' && planService.upgradeHint(feature)) ||
      'This feature is not included in your current BlueEye plan.';
    return res.status(403).json({
      success: false,
      error: 'feature_not_available',
      feature,
      message: hint,
    });
  };
}

module.exports = { createFeatureGate, requireFeature, requirePlanFeature, KNOWN_FEATURES };
