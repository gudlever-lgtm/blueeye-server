'use strict';

const crypto = require('crypto');
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
  // A freshly fetched proof is signed in direct response to THIS request, so its
  // signer timestamp (proof_issued_at) must be recent. Generous default (1h) —
  // far larger than the round-trip yet small enough to bound replay — so normal
  // clock skew can never cause a false denial.
  const proofMaxAgeMs = config.proofMaxAgeMs ?? 60 * 60 * 1000;

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

  // The cached proof carries the licence's own expiry; grace must never outlive
  // it (grace bridges an unreachable licens server, it does not extend a licence).
  function cachedProofExpired() {
    if (!state.payload || !state.payload.expiry) return false;
    const exp = Date.parse(state.payload.expiry);
    return !Number.isNaN(exp) && now() > exp;
  }

  // When we cannot obtain a fresh trusted proof, fall back to the cached proof
  // and the grace window.
  function applyOfflineFallback() {
    if (state.payload && withinGrace() && !cachedProofExpired()) {
      state.status = 'grace';
    } else {
      state.status = cachedProofExpired() ? 'expired' : 'unlicensed';
    }
  }

  // A signature-verified denial is durable: drop the cached proof (memory + disk)
  // so the offline/grace fallback can never resurrect entitlement the licens
  // server has explicitly withdrawn. Grace covers "could not reach the server",
  // never "the server said no".
  function clearCachedProof() {
    state.payload = null;
    state.verifiedAt = null;
    cache.write(null);
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

  async function fetchProof(agentCount, nonce) {
    const res = await fetchImpl(`${config.serverUrl}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        licenseKey: config.key,
        serverId: config.serverId,
        agentCount,
        nonce,
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
    // Per-request anti-replay nonce: the signer echoes it into the signed proof.
    const nonce = crypto.randomBytes(16).toString('hex');

    let body;
    try {
      body = await fetchProof(agentCount, nonce);
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
    // Anti-replay: a fresh proof must echo the nonce we just sent. A proof
    // without a nonce is indistinguishable from a replayed pre-nonce capture, so
    // it is rejected the same way (blueeye-licens has echoed the nonce since the
    // field was introduced; only a replay or a long-obsolete signer omits it).
    if (payload.nonce !== nonce) {
      state.lastError = 'nonce_mismatch';
      applyOfflineFallback();
      logger.error(
        payload.nonce === undefined
          ? 'License: proof carries no nonce — possible replay of an old capture; rejecting.'
          : 'License: proof nonce does not match the request — possible replay; rejecting.'
      );
      return getStatus();
    }

    // Defence-in-depth freshness: bound how old a freshly fetched proof may be,
    // using the SIGNED proof_issued_at stamp (which can't be altered/stripped
    // without breaking the signature). This bounds replay even on the legacy
    // path where a client doesn't send a nonce. Enforced only when the field is
    // present and parseable; a failure falls back to cache/grace (never a hard
    // outage), and a future-dated stamp (server clock behind) is tolerated.
    const proofIssuedAt = payload.proof_issued_at ? Date.parse(payload.proof_issued_at) : NaN;
    if (!Number.isNaN(proofIssuedAt) && now() - proofIssuedAt > proofMaxAgeMs) {
      state.lastError = 'proof_too_old';
      applyOfflineFallback();
      logger.error('License: proof timestamp is too old — possible replay; rejecting.');
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
      // A trusted negative — deny, and make the denial durable by clearing the
      // cached proof, so a later unreachable cycle cannot fall back into grace on
      // a proof this denial just contradicted. Distinguish an EXPIRED licence
      // (its validity window lapsed) from other hard denials (suspended /
      // revoked / server mismatch / agent-limit) so the dashboard can say
      // "expired" instead of the catch-all "invalid" — mirroring the offline
      // manager's status vocabulary.
      const reason = payload.reason || 'unknown';
      clearCachedProof();
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
