import config from '../config.js';
import * as registry from '../ws/registry.js';
import { verifyResponse } from './verify.js';
import { readCache, writeCache } from './cache.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * License manager.
 *
 * On startup and every `pollIntervalMs` it POSTs {licenseKey, serverId,
 * agentCount} to the license server's /validate endpoint, verifies the signed
 * response against the embedded public key, checks it is bound to our serverId,
 * and caches the last verified+valid validation on disk. When the license
 * server is unreachable it falls back to the cached validation for up to
 * `graceMs` (default 14 days), after which it hard-fails.
 *
 * The validation is a LICENSE PROOF, not an access token: it only governs
 * license validity and the local max_agents capacity gate. Agent
 * authentication is issued and validated entirely locally by blueeye-server
 * (Flow 1) and never involves the license server.
 */
export function createLicenseManager(opts = {}) {
  const {
    enabled = false,
    licenseKey = null,
    serverId = null,
    serverUrl = '',
    publicKeyPem = '',
    pollIntervalMs = 6 * 60 * 60 * 1000,
    graceMs = 14 * DAY_MS,
    cachePath = '/data/license-cache.json',
    fetchImpl = globalThis.fetch,
    getAgentCount = () => 0,
  } = opts;

  let timer = null;

  function loadCached() {
    return readCache(cachePath);
  }

  /**
   * Verify a raw /validate response and, if it proves a VALID license bound to
   * our serverId, persist it as the last-known-good validation.
   */
  function recordValidation(response, now = Date.now()) {
    const result = verifyResponse(response, publicKeyPem);
    if (!result.ok) {
      console.error(`[license] rejected validation: ${result.reason}`);
      return { ok: false, reason: result.reason };
    }
    const { payload } = result;
    if (serverId && payload.serverId !== serverId) {
      console.error(
        `[license] rejected validation: serverId mismatch ` +
          `(payload=${payload.serverId} expected=${serverId})`
      );
      return { ok: false, reason: 'serverId mismatch' };
    }
    if (payload.valid !== true) {
      // Verified and correctly addressed, but not currently valid. Surface it,
      // but keep the last-known-good cache so a transient negative answer
      // (e.g. a momentary over-limit) does not revoke a working install — the
      // grace clock continues on the previous good validation.
      console.warn(`[license] license server reports invalid: ${payload.reason}`);
      return { ok: true, valid: false, reason: payload.reason, payload };
    }
    writeCache(cachePath, { payload, verifiedAt: now });
    console.log('[license] stored verified validation');
    return { ok: true, valid: true, payload };
  }

  /** Effective enforcement state derived from the cached last-known-good validation. */
  function evaluate(now = Date.now()) {
    if (!enabled) {
      return { enabled: false, status: 'disabled', honor: true, maxAgents: Infinity, reason: null };
    }
    const cached = loadCached();
    if (!cached || !cached.payload || cached.payload.valid !== true) {
      return {
        enabled: true,
        status: 'unlicensed',
        honor: false,
        maxAgents: 0,
        reason: 'no verified license cached',
      };
    }
    const ageMs = now - (cached.verifiedAt ?? 0);
    const maxAgents = cached.payload.limits?.max_agents ?? 0;
    if (ageMs <= graceMs) {
      const fresh = ageMs <= pollIntervalMs * 2;
      return {
        enabled: true,
        status: fresh ? 'valid' : 'grace',
        honor: true,
        maxAgents,
        verifiedAt: cached.verifiedAt,
        ageMs,
        graceRemainingMs: graceMs - ageMs,
        reason: null,
      };
    }
    return {
      enabled: true,
      status: 'grace_expired',
      honor: false,
      maxAgents: 0,
      verifiedAt: cached.verifiedAt,
      ageMs,
      reason: `cached validation older than ${Math.floor(graceMs / DAY_MS)}d grace period`,
    };
  }

  /**
   * Capacity gate for a NEW agent connection. This is NOT authentication —
   * agent tokens are validated locally (Flow 1); the license only caps count.
   * `currentCount` is the number of agents already connected.
   */
  function canAcceptAgent(currentCount, now = Date.now()) {
    const state = evaluate(now);
    if (!state.enabled) {
      return { allowed: true };
    }
    if (!state.honor) {
      return { allowed: false, reason: state.reason ?? 'license not valid' };
    }
    if (currentCount >= state.maxAgents) {
      return { allowed: false, reason: `agent limit reached (max_agents=${state.maxAgents})` };
    }
    return { allowed: true };
  }

  function safeAgentCount() {
    try {
      return getAgentCount();
    } catch {
      return 0;
    }
  }

  /** Fetch a fresh validation from the license server, verify, and cache it. */
  async function refresh(now = Date.now()) {
    if (!enabled) {
      return { ok: false, reason: 'disabled' };
    }
    if (!fetchImpl) {
      return { ok: false, reason: 'no fetch implementation' };
    }
    const body = { licenseKey, serverId, agentCount: safeAgentCount() };
    let response;
    try {
      const res = await fetchImpl(`${serverUrl}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`[license] /validate returned HTTP ${res.status} — keeping cache`);
        return { ok: false, reason: `http ${res.status}` };
      }
      response = await res.json();
    } catch (err) {
      // Offline / unreachable — fall back to cache within the grace window.
      console.warn(`[license] license server unreachable (${err.message}) — using cache`);
      return { ok: false, reason: 'unreachable', offline: true };
    }
    return recordValidation(response, now);
  }

  function start() {
    if (!enabled) {
      console.log('[license] enforcement disabled (no LICENSE_KEY configured)');
      return;
    }
    if (!serverId) {
      console.warn('[license] LICENSE_KEY set but SERVER_ID missing — validations cannot be bound');
    }
    refresh().catch((err) => console.error(`[license] startup validation failed: ${err.message}`));
    const s = evaluate();
    console.log(`[license] startup state: ${s.status} (max_agents=${s.maxAgents})`);
    timer = setInterval(() => {
      refresh().catch((err) => console.error(`[license] periodic validation failed: ${err.message}`));
    }, pollIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    recordValidation,
    loadCached,
    evaluate,
    canAcceptAgent,
    refresh,
    start,
    stop,
    settings: { enabled, serverId, serverUrl, graceMs, pollIntervalMs, cachePath },
  };
}

// Default singleton wired from config and the live WebSocket agent registry.
const manager = createLicenseManager({
  ...config.license,
  getAgentCount: () => registry.count(),
});

export default manager;
