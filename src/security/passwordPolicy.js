'use strict';

// Pure password-policy evaluation for the security pack. No I/O — given a
// plaintext candidate and a policy object it returns the list of violations.
// Reuse-of-the-last-N and max-age are handled by the caller (they need the DB);
// everything checkable from the string alone lives here so it is trivially
// testable.
//
// A violation carries a stable `code` (for tests / the UI) and a human message.
// The route turns a non-empty list into HTTP 422 (policy violation), distinct
// from the 400 used for malformed input.

// bcrypt only hashes the first 72 bytes, so a longer minimum is meaningless.
const HARD_MAX = 72;

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSymbol: false,
  historyCount: 5, // refuse reuse of the last N passwords (0 disables)
  maxAgeDays: 0, // force change after N days (0 disables)
});

// Merges a stored/partial policy onto the defaults, clamping numbers to sane
// ranges so a bad stored value can never make the policy unsatisfiable.
function normalizePolicy(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const clampInt = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return def;
    return Math.min(Math.max(n, min), max);
  };
  const bool = (v, def) => (v === undefined ? def : v === true || v === 'true');
  return {
    enabled: bool(p.enabled, DEFAULT_POLICY.enabled),
    minLength: clampInt(p.minLength, DEFAULT_POLICY.minLength, 8, HARD_MAX),
    requireUppercase: bool(p.requireUppercase, DEFAULT_POLICY.requireUppercase),
    requireLowercase: bool(p.requireLowercase, DEFAULT_POLICY.requireLowercase),
    requireDigit: bool(p.requireDigit, DEFAULT_POLICY.requireDigit),
    requireSymbol: bool(p.requireSymbol, DEFAULT_POLICY.requireSymbol),
    historyCount: clampInt(p.historyCount, DEFAULT_POLICY.historyCount, 0, 50),
    maxAgeDays: clampInt(p.maxAgeDays, DEFAULT_POLICY.maxAgeDays, 0, 3650),
  };
}

// Evaluates the complexity/length rules. Returns { ok, violations:[{code,message}] }.
// History/age are NOT checked here (they need stored state).
function evaluatePassword(plain, policy) {
  const pol = normalizePolicy(policy);
  const pw = typeof plain === 'string' ? plain : '';
  const violations = [];
  const add = (code, message) => violations.push({ code, message });

  if (pw.length < pol.minLength) {
    add('min_length', `Password must be at least ${pol.minLength} characters`);
  }
  if (pol.requireUppercase && !/[A-Z]/.test(pw)) {
    add('uppercase', 'Password must contain an uppercase letter');
  }
  if (pol.requireLowercase && !/[a-z]/.test(pw)) {
    add('lowercase', 'Password must contain a lowercase letter');
  }
  if (pol.requireDigit && !/[0-9]/.test(pw)) {
    add('digit', 'Password must contain a digit');
  }
  // Anything that is not a letter, digit or whitespace counts as a symbol.
  if (pol.requireSymbol && !/[^A-Za-z0-9\s]/.test(pw)) {
    add('symbol', 'Password must contain a symbol');
  }

  return { ok: violations.length === 0, violations };
}

// Whether a password set at `changedAt` is older than the policy's max age.
// A 0/absent maxAgeDays or unknown change time means "not expired".
function isExpired(changedAt, policy, now = new Date()) {
  const pol = normalizePolicy(policy);
  if (!pol.enabled || !pol.maxAgeDays) return false;
  if (!changedAt) return false;
  const set = changedAt instanceof Date ? changedAt : new Date(changedAt);
  if (Number.isNaN(set.getTime())) return false;
  const ageMs = now.getTime() - set.getTime();
  return ageMs > pol.maxAgeDays * 24 * 60 * 60 * 1000;
}

module.exports = { DEFAULT_POLICY, HARD_MAX, normalizePolicy, evaluatePassword, isExpired };
