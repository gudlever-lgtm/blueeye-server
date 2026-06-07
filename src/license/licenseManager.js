'use strict';

const { verifyProof } = require('./verify');

const silentLogger = { info() {}, warn() {}, error() {} };
const DAY_MS = 24 * 60 * 60 * 1000;

// Drives client-side license validation against blueeye-licens.
//
// Status values:
//   'valid'       — a fresh, signature-verified validation said valid:true
//   'grace'       — cannot validate now, but a cached valid proof is within grace
//   'expired'     — a signature-verified proof said valid:false because the
//                   licence's own validity window lapsed (reason 'expired')
//   'invalid'     — a signature-verified proof said valid:false for another
//                   reason (e.g. revoked / suspended / server mismatch)
//   'unlicensed'  — no usable proof (never validated, or grace expired)
//   'unknown'     — not validated yet (initial)
//
// The signed proof is ONLY ever used as evidence of license status — never as an
// access token. Agent tokens remain entirely local to this server.
function createLicenseManager({
  config,                 // { key, serverId, serverUrl, graceDays, intervalHours }
  publicKey,              // PEM string or KeyObject
  cache,                  // { read(), write(data) }
  fetchImpl = fetch,
  now = () => Date.now(),
  logger = silentLogger,
  getAgentCount = () => 0,
}) {
  const graceMs = (config.graceDays ?? 14) * DAY_MS;

  const state = {
    status: 'unknown',
    payload: null, // last VALID verified payload
    verifiedAt: null, // ms timestamp of last successful valid validation
    lastCheckAt: null,
    lastError: null,
  };

  let timer = null;

  function withinGrace() {
    return state.verifiedAt !== null && now() - state.verifiedAt <= graceMs;
  }

  // When we cannot obtain a fresh valid proof, fall back to the cached proof and
  // the grace window.
  function applyOfflineFallback() {
    if (state.payload && withinGrace()) {
      state.status = 'grace';
    } else {
      state.status = 'unlicensed';
    }
  }

  // Loads a previously cached valid proof (called once at startup).
  function loadCache() {
    const cached = cache.read();
    if (cached && cached.payload && typeof cached.verifiedAt === 'number') {
      state.payload = cached.payload;
      state.verifiedAt = cached.verifiedAt;
      applyOfflineFallback();
    }
    return state;
  }

  function safeAgentCount() {
    try {
      const n = getAgentCount();
      return Number.isInteger(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  async function fetchProof(agentCount) {
    const res = await fetchImpl(`${config.serverUrl}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        licenseKey: config.key,
        serverId: config.serverId,
        agentCount,
      }),
    });
    if (res.status !== 200) {
      const err = new Error(`unexpected HTTP ${res.status}`);
      err.code = 'HTTP_STATUS';
      throw err;
    }
    return res.json();
  }

  // Performs one validation attempt and updates state. Never throws.
  async function validateOnce() {
    state.lastCheckAt = now();
    const agentCount = safeAgentCount();

    let body;
    try {
      body = await fetchProof(agentCount);
    } catch (err) {
      // Offline / unexpected status / unsigned response -> rely on cache + grace.
      state.lastError = `unreachable: ${err.message}`;
      applyOfflineFallback();
      logger.warn(`License: could not get a fresh validation (${err.message}); status=${state.status}.`);
      return getStatus();
    }

    const payload = body && body.payload;
    const signature = body && body.signature;

    // Reject anything we cannot cryptographically trust.
    if (!verifyProof(payload, signature, publicKey)) {
      state.lastError = 'invalid_signature';
      applyOfflineFallback();
      logger.error('License: response signature is INVALID — rejecting and falling back to cache.');
      return getStatus();
    }
    if (payload.serverId !== config.serverId) {
      state.lastError = 'server_mismatch';
      applyOfflineFallback();
      logger.error(
        `License: proof serverId (${payload.serverId}) does not match this server (${config.serverId}) — rejecting.`
      );
      return getStatus();
    }

    // Trusted proof.
    if (payload.valid === true) {
      state.payload = payload;
      state.verifiedAt = now();
      state.lastError = null;
      state.status = 'valid';
      cache.write({ payload, signature, verifiedAt: state.verifiedAt });
      logger.info(`License valid (max_agents=${getMaxAgents()}).`);
    } else {
      // A trusted negative — deny, do not cache as valid. Distinguish an EXPIRED
      // licence (its validity window lapsed) from other hard denials (suspended /
      // revoked / server mismatch / agent-limit) so the dashboard can say
      // "expired" instead of the catch-all "invalid" — mirroring the offline
      // manager's status vocabulary.
      const reason = payload.reason || 'unknown';
      state.lastError = reason;
      state.status = reason === 'expired' ? 'expired' : 'invalid';
      logger.error(`License is NOT valid (${reason}); denying agent operations.`);
    }
    return getStatus();
  }

  function isLicensed() {
    return state.status === 'valid' || state.status === 'grace';
  }

  function getMaxAgents() {
    if (state.payload && state.payload.limits && Number.isInteger(state.payload.limits.max_agents)) {
      return state.payload.limits.max_agents;
    }
    return 0;
  }

  // The signature-verified `features` map from the current valid/grace license,
  // or {} when there is no usable license. Read by the feature gate (fail-closed).
  function getFeatures() {
    if (!isLicensed()) return {};
    const f = state.payload && state.payload.features;
    return f && typeof f === 'object' ? f : {};
  }

  // The packaged plan key carried by the current valid/grace proof (e.g.
  // 'professional'), or '' when the proof predates the plan model / there is no
  // usable license. Resolved further by the plan service; never an access token.
  function getPlan() {
    if (!isLicensed()) return '';
    const p = state.payload && state.payload.plan;
    return typeof p === 'string' ? p : '';
  }

  // Whether a new agent connection is allowed given the current connection count.
  function canAcceptNewConnection(currentConnectionCount) {
    if (!isLicensed()) return false;
    return currentConnectionCount < getMaxAgents();
  }

  function getStatus() {
    return {
      status: state.status,
      licensed: isLicensed(),
      maxAgents: getMaxAgents(),
      plan: getPlan(),
      serverId: config.serverId,
      reason: state.lastError,
      withinGrace: withinGrace(),
      // The license's own expiry (from the signed proof), distinct from the
      // offline-grace window below. null = perpetual / no expiry in the proof.
      validUntil: state.payload && state.payload.expiry ? state.payload.expiry : null,
      verifiedAt: state.verifiedAt ? new Date(state.verifiedAt).toISOString() : null,
      graceUntil: state.verifiedAt ? new Date(state.verifiedAt + graceMs).toISOString() : null,
      lastCheckAt: state.lastCheckAt ? new Date(state.lastCheckAt).toISOString() : null,
    };
  }

  async function start() {
    loadCache();
    await validateOnce();
    const intervalMs = (config.intervalHours ?? 6) * 60 * 60 * 1000;
    timer = setInterval(() => {
      validateOnce().catch((err) => logger.error('License: periodic validation failed:', err));
    }, intervalMs);
    timer.unref();
    return getStatus();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    loadCache,
    validateOnce,
    start,
    stop,
    isLicensed,
    getMaxAgents,
    getPlan,
    getFeatures,
    canAcceptNewConnection,
    getStatus,
  };
}

module.exports = { createLicenseManager };
