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
function createFeatureGate({ licenseManager } = {}) {
  function features() {
    if (!licenseManager || typeof licenseManager.getFeatures !== 'function') return {};
    const f = licenseManager.getFeatures();
    return f && typeof f === 'object' ? f : {};
  }

  function isFeatureEnabled(feature) {
    return features()[feature] === true;
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

module.exports = { createFeatureGate, requireFeature, KNOWN_FEATURES };
