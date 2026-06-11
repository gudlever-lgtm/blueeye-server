'use strict';

// The security pack's orchestration layer. Wraps the runtime config
// (settingsService → `security` key), the licence gate and the persistence
// (usersRepo password history, authLockoutRepo) behind a small, route-friendly
// surface. The pure rules live in passwordPolicy/lockout/ipAllowlist; this glues
// them to I/O and to the Enterprise `security_pack` entitlement.
//
// LICENCE GATING: every control is a no-op unless the licence includes
// `security_pack` AND the control is enabled in settings. So a server without
// the Enterprise pack behaves exactly as before, and an admin must still opt in.

const { evaluatePassword, isExpired, normalizePolicy } = require('./passwordPolicy');
const { backoffSeconds, lockState, normalizeLockout } = require('./lockout');
const { isAllowed } = require('./ipAllowlist');
const { verifyPassword: defaultVerify } = require('../auth/password');

function createSecurityService({
  settingsService,
  featureGate = null,
  usersRepo = null,
  lockoutRepo = null,
  verifyPassword = defaultVerify,
  now = () => new Date(),
} = {}) {
  // Whether the Enterprise security pack is licensed. Fail-closed: no gate ⇒ off.
  function licensed() {
    return Boolean(featureGate && featureGate.isFeatureEnabled('security_pack'));
  }

  async function rawConfig() {
    if (settingsService && typeof settingsService.getSecurity === 'function') {
      try { return await settingsService.getSecurity(); } catch { /* fall through */ }
    }
    return {};
  }

  // Effective password policy — forced to enabled:false unless licensed.
  async function passwordPolicy() {
    const cfg = normalizePolicy((await rawConfig()).passwordPolicy);
    return { ...cfg, enabled: cfg.enabled && licensed() };
  }

  async function lockoutConfig() {
    const cfg = normalizeLockout((await rawConfig()).lockout);
    return { ...cfg, enabled: cfg.enabled && licensed() };
  }

  async function ipAllowlistConfig() {
    const cfg = (await rawConfig()).ipAllowlist || {};
    return { ...cfg, enabled: Boolean(cfg.enabled) && licensed() };
  }

  // ---- Password policy --------------------------------------------------------
  // Evaluates a candidate password against the complexity rules and, when a
  // userId is given, the reuse-of-the-last-N history. Returns
  // { ok, violations:[{code,message}] }. A no-op (ok:true) when disabled.
  async function evaluateNewPassword({ userId = null, plain }) {
    const pol = await passwordPolicy();
    if (!pol.enabled) return { ok: true, violations: [] };
    const { violations } = evaluatePassword(plain, pol);
    if (pol.historyCount > 0 && userId != null && usersRepo && typeof usersRepo.recentPasswordHashes === 'function') {
      try {
        const hashes = await usersRepo.recentPasswordHashes(userId, pol.historyCount);
        for (const h of hashes) {
          if (await verifyPassword(plain, h)) {
            violations.push({ code: 'reuse', message: `Password must not match any of the last ${pol.historyCount} passwords` });
            break;
          }
        }
      } catch { /* if history is unreadable, fall back to complexity-only */ }
    }
    return { ok: violations.length === 0, violations };
  }

  // Is the password set at `changedAt` past the configured max age?
  async function isPasswordExpired(changedAt) {
    return isExpired(changedAt, await passwordPolicy(), now());
  }

  // ---- Brute-force lockout ----------------------------------------------------
  // The (scope, identifier) pairs we track for one login attempt.
  function principals({ email, ip }) {
    const out = [];
    if (email) out.push(['user', String(email).toLowerCase()]);
    if (ip) out.push(['ip', String(ip)]);
    return out;
  }

  // Is either the user or the source IP currently locked out? Returns
  // { locked, scope, retryAfterSeconds }.
  async function checkLockout({ email, ip }) {
    const cfg = await lockoutConfig();
    if (!cfg.enabled || !lockoutRepo) return { locked: false, retryAfterSeconds: 0 };
    for (const [scope, id] of principals({ email, ip })) {
      const row = await lockoutRepo.get(scope, id);
      const st = lockState(row && row.locked_until, now());
      if (st.locked) return { locked: true, scope, retryAfterSeconds: st.retryAfterSeconds };
    }
    return { locked: false, retryAfterSeconds: 0 };
  }

  // Records a failed login against both the user and the source IP, escalating
  // the backoff. Best-effort: never throws into the login path.
  async function recordFailure({ email, ip }) {
    const cfg = await lockoutConfig();
    if (!cfg.enabled || !lockoutRepo) return;
    const ts = now();
    const windowMs = cfg.windowSeconds * 1000;
    for (const [scope, id] of principals({ email, ip })) {
      try {
        const row = await lockoutRepo.get(scope, id);
        let failCount = 1;
        let firstFailedAt = ts;
        if (row) {
          const last = row.last_failed_at ? new Date(row.last_failed_at).getTime() : 0;
          const withinWindow = last && ts.getTime() - last <= windowMs;
          const stillLocked = lockState(row.locked_until, ts).locked;
          if (withinWindow || stillLocked) {
            failCount = Number(row.fail_count || 0) + 1;
            firstFailedAt = row.first_failed_at ? new Date(row.first_failed_at) : ts;
          }
        }
        const secs = backoffSeconds(failCount, cfg);
        const lockedUntil = secs > 0 ? new Date(ts.getTime() + secs * 1000) : null;
        await lockoutRepo.upsert(scope, id, { failCount, firstFailedAt, lastFailedAt: ts, lockedUntil });
      } catch { /* best-effort */ }
    }
  }

  // Clears failure state for the user + IP after a successful login.
  async function recordSuccess({ email, ip }) {
    if (!lockoutRepo) return;
    for (const [scope, id] of principals({ email, ip })) {
      try { await lockoutRepo.clear(scope, id); } catch { /* best-effort */ }
    }
  }

  // ---- IP allowlist -----------------------------------------------------------
  // Decides whether `ip` may sign in as `role`. { allowed, restricted }.
  async function checkIp({ ip, role }) {
    const cfg = await ipAllowlistConfig();
    return isAllowed(ip, role, cfg);
  }

  return {
    licensed,
    passwordPolicy,
    lockoutConfig,
    ipAllowlistConfig,
    evaluateNewPassword,
    isPasswordExpired,
    checkLockout,
    recordFailure,
    recordSuccess,
    checkIp,
  };
}

module.exports = { createSecurityService };
