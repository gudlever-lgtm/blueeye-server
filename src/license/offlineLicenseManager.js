'use strict';

const silentLogger = { info() {}, warn() {}, error() {} };

// Drives license state from a LOCAL signed license file — a drop-in replacement
// for the online licenseManager that NEVER contacts an external server. It
// exposes the identical surface (isLicensed / getMaxAgents / getPlan /
// getFeatures / canAcceptNewConnection / getStatus / start / stop /
// validateOnce) so every existing consumer (feature gate, WS connection guard,
// alerting/analysis gates, routes) works unchanged.
//
// When the license is missing, malformed, not yet valid, expired or its
// signature does not verify, the manager reports NOT licensed — which puts the
// rest of the system into restricted mode (the plan service falls back to the
// locked-down 'unlicensed' plan: zero limits, no features).
function createOfflineLicenseManager({
  verifier, // createLicenseVerifier({ publicKey, serverId })
  filePath, // path to the signed license JSON
  serverId = '',
  recheckHours = 6, // re-read the file periodically to catch valid_until crossing
  now = () => Date.now(),
  logger = silentLogger,
  // See licenseManager.js — same trust-anchor provenance, surfaced through
  // getStatus() so the dashboard can explain an 'invalid_signature' result
  // that's actually "verifying against the wrong key", not a bad license file.
  keyTrust = { source: 'embedded', configured: true },
} = {}) {
  const state = {
    status: 'unknown', // 'valid' | 'expired' | 'not_yet_valid' | 'invalid' | 'unlicensed' | 'unknown'
    result: null, // last verifier result
    loadedAt: null, // ms of last successful (valid) load
    lastCheckAt: null,
    reason: null,
  };

  let timer = null;

  // Maps a verifier status onto the manager's status vocabulary.
  function mapStatus(vstatus) {
    if (vstatus === 'valid') return 'valid';
    if (vstatus === 'expired') return 'expired';
    if (vstatus === 'not_yet_valid') return 'not_yet_valid';
    if (vstatus === 'missing') return 'unlicensed';
    return 'invalid'; // malformed / invalid_signature / server_mismatch
  }

  // Reads + verifies the file and updates state. Never throws.
  function evaluate() {
    state.lastCheckAt = now();
    const result = verifier ? verifier.verifyFile(filePath) : { valid: false, status: 'missing', reason: 'no verifier' };
    state.result = result;
    state.status = mapStatus(result.status);
    state.reason = result.reason || null;
    if (result.valid) {
      state.loadedAt = now();
      logger.info(`Offline license valid (plan=${result.plan || '—'}, until=${result.validUntil || '—'}).`);
    } else {
      logger.warn(`Offline license not usable (${result.status}: ${result.reason}); entering restricted mode.`);
    }
    return getStatus();
  }

  // A re-evaluation is just another local read — no network, so validateOnce is
  // safe to call as often as the UI's "Re-validate now" button is pressed.
  async function validateOnce() {
    return evaluate();
  }

  function isLicensed() {
    return state.status === 'valid';
  }

  function current() {
    return isLicensed() && state.result ? state.result : null;
  }

  function getMaxAgents() {
    const r = current();
    if (r && r.limits && Number.isInteger(r.limits.max_agents)) return r.limits.max_agents;
    return 0; // 0 → plan service uses the plan default
  }

  // Optional test-path override (mirrors getMaxAgents); the plan service uses it
  // when > 0, else the plan default applies.
  function getMaxTestPaths() {
    const r = current();
    if (r && r.limits && Number.isInteger(r.limits.max_test_paths)) return r.limits.max_test_paths;
    return 0;
  }

  function getPlan() {
    const r = current();
    return r && typeof r.plan === 'string' ? r.plan : '';
  }

  // The feature map fed to the (fail-closed) feature gate. Built from the
  // license's enabled_features_override; {} when not licensed.
  function getFeatures() {
    const r = current();
    return r && r.features && typeof r.features === 'object' ? r.features : {};
  }

  function canAcceptNewConnection(currentConnectionCount) {
    if (!isLicensed()) return false;
    const max = getMaxAgents();
    if (max <= 0) return true; // no per-license agent cap → plan governs elsewhere
    return currentConnectionCount < max;
  }

  function getStatus() {
    const r = state.result;
    return {
      mode: 'offline',
      status: state.status,
      licensed: isLicensed(),
      maxAgents: getMaxAgents(),
      maxTestPaths: getMaxTestPaths(),
      plan: getPlan(),
      organizationId: r && r.organizationId != null ? r.organizationId : null,
      serverId,
      reason: state.reason,
      withinGrace: false,
      validFrom: r && r.validFrom ? r.validFrom : null,
      validUntil: r && r.validUntil ? r.validUntil : null,
      verifiedAt: state.loadedAt ? new Date(state.loadedAt).toISOString() : null,
      graceUntil: null,
      lastCheckAt: state.lastCheckAt ? new Date(state.lastCheckAt).toISOString() : null,
      publicKeyTrust: keyTrust,
    };
  }

  async function start() {
    evaluate();
    const intervalMs = Math.max(1, recheckHours) * 60 * 60 * 1000;
    timer = setInterval(() => {
      try {
        evaluate();
      } catch (err) {
        logger.error('Offline license: periodic re-check failed:', err);
      }
    }, intervalMs);
    if (timer.unref) timer.unref();
    return getStatus();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    validateOnce,
    isLicensed,
    getMaxAgents,
    getMaxTestPaths,
    getPlan,
    getFeatures,
    canAcceptNewConnection,
    getStatus,
  };
}

module.exports = { createOfflineLicenseManager };
