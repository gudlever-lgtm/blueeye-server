'use strict';

// Pure brute-force lockout maths for the security pack. Given the current
// failure streak and the policy, decide how long (if at all) the principal is
// locked out. Stateful counting/storage lives in authLockoutRepository; this
// module just turns "N failures" into "locked until when", with exponential
// backoff, so the rule is testable in isolation.

const DEFAULT_LOCKOUT = Object.freeze({
  enabled: false,
  maxAttempts: 5, // allow this many failures before the FIRST lockout
  baseBackoffSeconds: 60, // backoff for the first lockout
  maxBackoffSeconds: 3600, // cap the exponential growth here
  windowSeconds: 900, // failures older than this reset the streak
});

function normalizeLockout(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const clampInt = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return def;
    return Math.min(Math.max(n, min), max);
  };
  const bool = (v, def) => (v === undefined ? def : v === true || v === 'true');
  return {
    enabled: bool(p.enabled, DEFAULT_LOCKOUT.enabled),
    maxAttempts: clampInt(p.maxAttempts, DEFAULT_LOCKOUT.maxAttempts, 1, 100),
    baseBackoffSeconds: clampInt(p.baseBackoffSeconds, DEFAULT_LOCKOUT.baseBackoffSeconds, 1, 86400),
    maxBackoffSeconds: clampInt(p.maxBackoffSeconds, DEFAULT_LOCKOUT.maxBackoffSeconds, 1, 604800),
    windowSeconds: clampInt(p.windowSeconds, DEFAULT_LOCKOUT.windowSeconds, 10, 86400),
  };
}

// Backoff in seconds after `failCount` total failures. No lockout until the
// streak exceeds maxAttempts; after that it doubles each extra failure:
//   fail = maxAttempts+1 -> base
//   fail = maxAttempts+2 -> base*2
//   ...capped at maxBackoffSeconds.
function backoffSeconds(failCount, policy) {
  const pol = normalizeLockout(policy);
  if (failCount <= pol.maxAttempts) return 0;
  const over = failCount - pol.maxAttempts - 1; // 0-based exponent
  const secs = pol.baseBackoffSeconds * Math.pow(2, over);
  return Math.min(secs, pol.maxBackoffSeconds);
}

// Whether the stored row says the principal is locked right now, and for how
// many more seconds. `lockedUntil` is a Date/ISO string or null.
function lockState(lockedUntil, now = new Date()) {
  if (!lockedUntil) return { locked: false, retryAfterSeconds: 0 };
  const until = lockedUntil instanceof Date ? lockedUntil : new Date(lockedUntil);
  if (Number.isNaN(until.getTime())) return { locked: false, retryAfterSeconds: 0 };
  const ms = until.getTime() - now.getTime();
  if (ms <= 0) return { locked: false, retryAfterSeconds: 0 };
  return { locked: true, retryAfterSeconds: Math.ceil(ms / 1000) };
}

module.exports = { DEFAULT_LOCKOUT, normalizeLockout, backoffSeconds, lockState };
