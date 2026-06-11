'use strict';

// Baseline brute-force lockout for POST /auth/login. ALWAYS ON — not behind any
// licence feature key. Counts failed attempts per login identifier (email) AND
// per source IP; once either crosses `maxAttempts` within `windowMs` that key is
// locked for an exponentially backing-off window, and the router answers 429
// (instead of the ordinary 401) so the audit log can tell a lockout apart from
// a plain bad-credential failure.
//
// State is process-local and best-effort: a restart clears it, which is fine for
// a single on-prem node. The store is injectable so a future HA deployment can
// back it with a shared cache without touching the route. Time is injectable for
// deterministic tests.
function createLoginThrottle({
  maxAttempts = 5, // failures (per key) tolerated before the next attempt locks
  windowMs = 15 * 60 * 1000, // failures older than this are forgotten
  baseLockoutMs = 60 * 1000, // first lockout length; doubles on repeat lockouts
  maxLockoutMs = 60 * 60 * 1000, // cap on the exponential backoff
  now = () => Date.now(),
} = {}) {
  // key -> { fails, firstAt, lockedUntil, lockouts }
  const buckets = new Map();

  function bucketFor(key) {
    let b = buckets.get(key);
    if (!b) {
      b = { fails: 0, firstAt: now(), lockedUntil: 0, lockouts: 0 };
      buckets.set(key, b);
    }
    return b;
  }

  function keysFor({ email, ip } = {}) {
    const keys = [];
    if (email) keys.push(`user:${String(email).toLowerCase()}`);
    if (ip) keys.push(`ip:${ip}`);
    return keys;
  }

  // Remaining lock time for a single key (0 = open). Also expires a stale
  // counting window so old failures don't accumulate forever.
  function lockedMsForKey(key) {
    const b = buckets.get(key);
    if (!b) return 0;
    const t = now();
    if (b.lockedUntil > t) return b.lockedUntil - t;
    if (b.fails > 0 && t - b.firstAt > windowMs) {
      b.fails = 0;
      b.firstAt = t;
    }
    return 0;
  }

  // Call BEFORE checking credentials. { locked, retryAfterMs, retryAfterSec }.
  function check(id) {
    let retry = 0;
    for (const key of keysFor(id)) retry = Math.max(retry, lockedMsForKey(key));
    return { locked: retry > 0, retryAfterMs: retry, retryAfterSec: Math.ceil(retry / 1000) };
  }

  // Record a failed login. May transition one or both keys into a locked state.
  function recordFailure(id) {
    const t = now();
    for (const key of keysFor(id)) {
      const b = bucketFor(key);
      if (t - b.firstAt > windowMs) {
        b.fails = 0;
        b.firstAt = t;
      }
      b.fails += 1;
      if (b.fails >= maxAttempts) {
        const backoff = Math.min(baseLockoutMs * 2 ** b.lockouts, maxLockoutMs);
        b.lockedUntil = t + backoff;
        b.lockouts += 1;
        b.fails = 0;
        b.firstAt = t;
      }
    }
  }

  // Clear counters on a successful login (both the email and IP keys).
  function recordSuccess(id) {
    for (const key of keysFor(id)) buckets.delete(key);
  }

  return { check, recordFailure, recordSuccess };
}

module.exports = { createLoginThrottle };
