import config from '../config.js';
import { verifySignedLicense } from './verify.js';
import { readCache, writeCache } from './cache.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const VALIDATE_TIMEOUT_MS = 10000;

/**
 * License states:
 *   disabled    – enforcement off (no license configured)
 *   unlicensed  – enabled, never validated and no usable cache → hard fail
 *   valid       – validated online against the license server just now
 *   grace       – server unreachable, but a cached validation is within the
 *                 offline grace period
 *   invalid     – grace expired, or the server affirmatively rejected us
 *   expired     – the signed license itself is past its expiry
 *
 * `valid` and `grace` are the only "operational" states — anything else means
 * new agent connections are refused.
 */

export function createLicenseManager(opts = {}) {
  const enabled = opts.enabled ?? config.licenseEnabled;
  const licenseKey = opts.licenseKey ?? config.licenseKey;
  const serverId = opts.serverId ?? config.serverId;
  const licenseServerUrl = opts.licenseServerUrl ?? config.licenseServerUrl;
  const publicKey = opts.publicKey ?? config.licensePublicKey;
  const graceMs = opts.graceMs ?? config.licenseGraceDays * DAY_MS;
  const cachePath = opts.cachePath ?? config.licenseCachePath;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());

  const state = {
    status: enabled ? 'unlicensed' : 'disabled',
    license: null, // parsed claims: { maxAgents, expiresAt, ... }
    lastValidatedAt: null, // ms of last online-verified validation
    source: null, // 'server' | 'cache'
    lastError: null,
  };

  function isOperational() {
    if (!enabled) return true;
    return state.status === 'valid' || state.status === 'grace';
  }

  function maxAgents() {
    if (!enabled) return Infinity;
    return state.license?.maxAgents ?? 0;
  }

  /**
   * Decide whether `agentId` may (re)connect. Re-connections from an already
   * registered agent never count against the cap; only *new* distinct agents
   * beyond `maxAgents` are refused.
   *
   * @param {string} agentId
   * @param {string[]} currentAgentIds  ids currently registered (registry.list())
   * @returns {{ok: true} | {ok: false, code: number, reason: string}}
   */
  function canRegisterAgent(agentId, currentAgentIds = []) {
    if (!enabled) return { ok: true };
    if (!isOperational()) {
      return { ok: false, code: 4001, reason: `license ${state.status}` };
    }
    const alreadyConnected = currentAgentIds.includes(agentId);
    if (!alreadyConnected && currentAgentIds.length >= maxAgents()) {
      return {
        ok: false,
        code: 4002,
        reason: `agent limit reached (max ${maxAgents()})`,
      };
    }
    return { ok: true };
  }

  /**
   * Recompute status when we are relying on the cached license rather than a
   * fresh online answer (offline, network error, or an untrusted response).
   */
  function applyOfflineStatus() {
    if (!state.license || state.lastValidatedAt == null) {
      state.status = 'invalid';
      return;
    }
    // A concrete expiry in the signed license is authoritative even offline.
    if (state.license.expiresAt && now() > state.license.expiresAt) {
      state.status = 'expired';
      return;
    }
    const age = now() - state.lastValidatedAt;
    state.status = age <= graceMs ? 'grace' : 'invalid';
  }

  function adoptLicense(license, signedLicense, signature, persist) {
    state.license = license;
    state.lastValidatedAt = now();
    state.source = 'server';
    state.lastError = null;
    state.status = 'valid';
    if (persist) {
      writeCache(cachePath, {
        signedLicense,
        signature,
        validatedAt: state.lastValidatedAt,
      });
    }
  }

  async function postValidate() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${licenseServerUrl}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey, serverId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run one validation cycle. Always resolves with the current state; it never
   * throws, so it is safe to call from a timer or at startup.
   */
  async function validateNow() {
    if (!enabled) return getState();

    let response;
    try {
      response = await postValidate();
    } catch (err) {
      // Offline / network / HTTP / timeout → fall back to cache + grace window.
      state.lastError = `validation request failed: ${err.message}`;
      applyOfflineStatus();
      console.warn(
        `[license] offline (${state.lastError}); status=${state.status}`
      );
      return getState();
    }

    // We got a response — it must verify against the embedded public key.
    let license;
    try {
      license = verifySignedLicense(
        response.signedLicense,
        response.signature,
        publicKey
      );
    } catch (err) {
      // An unverifiable response is untrusted (possible MITM). Do not adopt it
      // and do not extend grace — fall back to the last known-good cache.
      state.lastError = `signature verification failed: ${err.message}`;
      applyOfflineStatus();
      console.error(`[license] ${state.lastError}; status=${state.status}`);
      return getState();
    }

    // The signed claims must be bound to *this* deployment.
    if (license.serverId !== serverId || license.licenseKey !== licenseKey) {
      state.lastError = 'license identity mismatch';
      applyOfflineStatus();
      console.error(`[license] ${state.lastError}; status=${state.status}`);
      return getState();
    }

    // Authoritative "no" from the server — no grace for an explicit rejection.
    if (license.active === false || license.status === 'revoked') {
      state.license = license;
      state.status = 'invalid';
      state.source = 'server';
      state.lastError = 'license revoked';
      console.error('[license] license revoked by server');
      return getState();
    }
    if (license.expiresAt && now() > license.expiresAt) {
      state.license = license;
      state.status = 'expired';
      state.source = 'server';
      state.lastError = 'license expired';
      console.error('[license] license expired');
      return getState();
    }

    adoptLicense(license, response.signedLicense, response.signature, true);
    console.log(
      `[license] validated (maxAgents=${maxAgents()}, source=server)`
    );
    return getState();
  }

  /**
   * Load the cached validation from disk so we have a usable license (within
   * grace) even before — or instead of — the first successful online call.
   */
  function loadFromCache() {
    if (!enabled) return;
    const cached = readCache(cachePath);
    if (!cached) return;
    try {
      const license = verifySignedLicense(
        cached.signedLicense,
        cached.signature,
        publicKey
      );
      if (license.serverId !== serverId || license.licenseKey !== licenseKey) {
        return;
      }
      state.license = license;
      state.lastValidatedAt = cached.validatedAt;
      state.source = 'cache';
      applyOfflineStatus();
      console.log(
        `[license] loaded cached validation (status=${state.status})`
      );
    } catch {
      // tampered / unverifiable cache → ignore it
    }
  }

  let timer = null;
  function startPeriodic(intervalMs = config.licenseValidateIntervalMs) {
    if (!enabled || timer) return;
    timer = setInterval(() => {
      validateNow().catch(() => {});
    }, intervalMs);
    timer.unref?.();
  }
  function stopPeriodic() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getState() {
    return {
      enabled,
      status: state.status,
      operational: isOperational(),
      maxAgents: enabled ? state.license?.maxAgents ?? null : null,
      expiresAt: state.license?.expiresAt ?? null,
      lastValidatedAt: state.lastValidatedAt,
      graceUntil:
        enabled && state.lastValidatedAt != null
          ? state.lastValidatedAt + graceMs
          : null,
      source: state.source,
      lastError: state.lastError,
    };
  }

  // Seed state from disk immediately on construction.
  loadFromCache();

  return {
    validateNow,
    canRegisterAgent,
    isOperational,
    maxAgents,
    getState,
    startPeriodic,
    stopPeriodic,
    loadFromCache,
  };
}

// ---- module singleton, wired by the app (mirrors db/database.js) ----

let instance = null;

export function initLicense(opts) {
  instance = createLicenseManager(opts);
  return instance;
}

export function getLicense() {
  if (!instance) {
    instance = createLicenseManager();
  }
  return instance;
}
