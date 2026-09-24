'use strict';

const net = require('net');
const { ALL_ROLES } = require('./roles');

// Baseline security policy (migration 041) — the three always-on controls whose
// CONFIGURATION lives in app_settings under the `security` key:
//
//   passwordHistory     refuse reuse of the current + last N local passwords
//                       (0 disables; history rows are then pruned away)
//   passwordMaxAgeDays  opt-in: a local password older than this must be changed
//                       before anything else (0 = off, the default)
//   ipAllowlist         { admin: [cidr…], operator: […], viewer: […] } — a role
//                       with an empty/absent list is unrestricted
//
// Never licence-gated. Pure helpers + one small cache: the request gate reads the
// policy on every authenticated request, so it must not cost a DB read each time.

const SECURITY_DEFAULTS = Object.freeze({
  passwordHistory: 5,
  passwordMaxAgeDays: 0,
  ipAllowlist: Object.freeze({ admin: Object.freeze([]), operator: Object.freeze([]), viewer: Object.freeze([]) }),
});

// Bounds. History is bcrypt-compared once per remembered hash on every change,
// so the cap also bounds how long a change can take (24 × one bcrypt compare).
const PASSWORD_HISTORY_MAX = 24;
const PASSWORD_MAX_AGE_MAX_DAYS = 3650;
const ALLOWLIST_MAX_PER_ROLE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

// Canonical form of a client address: brackets and a zone id stripped, and an
// IPv4-mapped IPv6 address (::ffff:10.0.0.1 — what Node reports for IPv4 on a
// dual-stack socket) reduced to plain IPv4, so an IPv4 allowlist matches it.
// Returns { address, family: 'ipv4'|'ipv6' } or null.
function normalizeIp(ip) {
  if (typeof ip !== 'string') return null;
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1];
  const v = net.isIP(s);
  if (v === 4) return { address: s, family: 'ipv4' };
  if (v === 6) return { address: s.toLowerCase(), family: 'ipv6' };
  return null;
}

// Parses one allowlist entry — an address or a CIDR, IPv4 or IPv6. A bare
// address is a single host (/32 or /128). Returns
// { cidr, address, prefix, family } with `cidr` in canonical text, or null.
function parseAllowEntry(entry) {
  if (typeof entry !== 'string') return null;
  const s = entry.trim();
  if (!s || s.length > 64) return null;
  const slash = s.indexOf('/');
  const addrPart = slash === -1 ? s : s.slice(0, slash);
  const ip = normalizeIp(addrPart);
  if (!ip) return null;
  const max = ip.family === 'ipv4' ? 32 : 128;
  let prefix = max;
  if (slash !== -1) {
    const p = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return null;
    prefix = Number(p);
    if (prefix < 0 || prefix > max) return null;
  }
  return { cidr: `${ip.address}/${prefix}`, address: ip.address, prefix, family: ip.family };
}

// Compiles a list of parsed entries into a net.BlockList (used here as an
// ALLOW list: `check` answers "is this address in any of the ranges").
function compileList(entries) {
  const list = new net.BlockList();
  for (const e of entries) list.addSubnet(e.address, e.prefix, e.family);
  return list;
}

// Is `ip` inside any of `cidrs` (strings)? Unparseable entries are ignored;
// an unparseable client address is never inside anything.
function ipInList(ip, cidrs) {
  const addr = normalizeIp(ip);
  if (!addr) return false;
  const parsed = (Array.isArray(cidrs) ? cidrs : []).map(parseAllowEntry).filter(Boolean);
  if (!parsed.length) return false;
  return compileList(parsed).check(addr.address, addr.family);
}

// The effective policy from whatever is stored (null, partial, or garbage from
// an older version): every field falls back to its default, every allowlist
// entry that does not parse is dropped. Always returns a complete policy.
function normalizeSecurity(stored) {
  const o = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const intIn = (v, min, max, dflt) => (Number.isInteger(v) && v >= min && v <= max ? v : dflt);
  const lists = o.ipAllowlist && typeof o.ipAllowlist === 'object' && !Array.isArray(o.ipAllowlist) ? o.ipAllowlist : {};
  const ipAllowlist = {};
  for (const role of ALL_ROLES) {
    const raw = Array.isArray(lists[role]) ? lists[role] : [];
    const seen = new Set();
    ipAllowlist[role] = [];
    for (const entry of raw) {
      const p = parseAllowEntry(entry);
      if (!p || seen.has(p.cidr)) continue;
      seen.add(p.cidr);
      ipAllowlist[role].push(p.cidr);
      if (ipAllowlist[role].length >= ALLOWLIST_MAX_PER_ROLE) break;
    }
  }
  return {
    passwordHistory: intIn(o.passwordHistory, 0, PASSWORD_HISTORY_MAX, SECURITY_DEFAULTS.passwordHistory),
    passwordMaxAgeDays: intIn(o.passwordMaxAgeDays, 0, PASSWORD_MAX_AGE_MAX_DAYS, SECURITY_DEFAULTS.passwordMaxAgeDays),
    ipAllowlist,
  };
}

// Validates a (partial) PUT body. Only the fields present are checked; an
// allowlist patch may name any subset of the roles. Returns { errors, value }
// with errors as a field → message map (null when clean).
function validateSecurity(patch) {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const errors = {};
  const value = {};
  if (p.passwordHistory !== undefined) {
    const n = Number(p.passwordHistory);
    if (!Number.isInteger(n) || n < 0 || n > PASSWORD_HISTORY_MAX) {
      errors.passwordHistory = `passwordHistory must be an integer between 0 and ${PASSWORD_HISTORY_MAX}`;
    } else value.passwordHistory = n;
  }
  if (p.passwordMaxAgeDays !== undefined) {
    const n = Number(p.passwordMaxAgeDays);
    if (!Number.isInteger(n) || n < 0 || n > PASSWORD_MAX_AGE_MAX_DAYS) {
      errors.passwordMaxAgeDays = `passwordMaxAgeDays must be an integer between 0 and ${PASSWORD_MAX_AGE_MAX_DAYS}`;
    } else value.passwordMaxAgeDays = n;
  }
  if (p.ipAllowlist !== undefined) {
    const lists = p.ipAllowlist;
    if (!lists || typeof lists !== 'object' || Array.isArray(lists)) {
      errors.ipAllowlist = 'ipAllowlist must be an object of role → list of addresses/CIDRs';
    } else {
      const out = {};
      for (const key of Object.keys(lists)) {
        if (!ALL_ROLES.includes(key)) { errors[`ipAllowlist.${key}`] = `unknown role "${String(key).slice(0, 32)}"`; continue; }
        const raw = lists[key];
        if (raw === null) { out[key] = []; continue; }
        if (!Array.isArray(raw)) { errors[`ipAllowlist.${key}`] = 'must be a list of addresses/CIDRs'; continue; }
        if (raw.length > ALLOWLIST_MAX_PER_ROLE) { errors[`ipAllowlist.${key}`] = `at most ${ALLOWLIST_MAX_PER_ROLE} entries`; continue; }
        const seen = new Set();
        const list = [];
        for (const entry of raw) {
          if (typeof entry === 'string' && entry.trim() === '') continue;
          const parsed = parseAllowEntry(entry);
          if (!parsed) { errors[`ipAllowlist.${key}`] = `invalid address or CIDR: ${String(entry).slice(0, 64)}`; break; }
          if (seen.has(parsed.cidr)) continue;
          seen.add(parsed.cidr);
          list.push(parsed.cidr);
        }
        if (!errors[`ipAllowlist.${key}`]) out[key] = list;
      }
      value.ipAllowlist = out;
    }
  }
  return { errors: Object.keys(errors).length ? errors : null, value };
}

// Merges a validated patch over the current effective policy.
function mergeSecurity(current, value) {
  const cur = normalizeSecurity(current);
  return normalizeSecurity({
    passwordHistory: value.passwordHistory !== undefined ? value.passwordHistory : cur.passwordHistory,
    passwordMaxAgeDays: value.passwordMaxAgeDays !== undefined ? value.passwordMaxAgeDays : cur.passwordMaxAgeDays,
    ipAllowlist: { ...cur.ipAllowlist, ...(value.ipAllowlist || {}) },
  });
}

// When a password set at `changedAt` expires under `maxAgeDays`, as epoch ms;
// null when max age is off or the time is unknown.
function passwordExpiresAt(changedAt, maxAgeDays) {
  if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) return null;
  if (changedAt === null || changedAt === undefined || changedAt === '') return null;
  const t = changedAt instanceof Date ? changedAt.getTime() : new Date(changedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return t + maxAgeDays * DAY_MS;
}

function isPasswordExpired(changedAt, maxAgeDays, now = Date.now()) {
  const exp = passwordExpiresAt(changedAt, maxAgeDays);
  return exp !== null && exp <= now;
}

// A local user's effective "password set at": password_changed_at, or the
// account's created_at while it has never changed (rows from before migration
// 041). Returns a Date or null.
function passwordSetAt(user) {
  if (!user) return null;
  const v = user.password_changed_at || user.created_at || null;
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Cached view of the stored policy. `load()` returns the raw stored value (the
// settings service's getSecurity). Reads are served from the cache for `ttlMs`,
// so a change saved on another instance lands within that window and a change
// saved here lands at once (invalidate()). A failed read keeps the last-known
// policy — or the defaults, which restrict nothing by IP — rather than locking
// every user out because the settings table hiccupped.
function createSecurityPolicy({ load, ttlMs = 5000, now = () => Date.now(), logger = null } = {}) {
  let cached = null; // { policy, compiled, at }
  let inflight = null;

  function compile(policy) {
    const compiled = {};
    for (const role of ALL_ROLES) {
      const parsed = policy.ipAllowlist[role].map(parseAllowEntry).filter(Boolean);
      compiled[role] = parsed.length ? compileList(parsed) : null;
    }
    return compiled;
  }

  function set(policy) {
    const eff = normalizeSecurity(policy);
    cached = { policy: eff, compiled: compile(eff), at: now() };
    return eff;
  }

  async function refresh() {
    try {
      const raw = typeof load === 'function' ? await load() : null;
      return set(raw);
    } catch (err) {
      if (logger && logger.warn) logger.warn(`security policy: read failed (${err.message}); keeping the last-known policy`);
      if (cached) { cached.at = now(); return cached.policy; }
      return set(null);
    }
  }

  async function get() {
    if (cached && now() - cached.at < ttlMs) return cached.policy;
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  }

  // Synchronous last-known policy (defaults before the first read) — for the
  // WebSocket upgrade, which verifies synchronously.
  function snapshot() {
    return cached ? cached.policy : normalizeSecurity(null);
  }

  function invalidate() { if (cached) cached.at = -Infinity; }

  // Role-based allowlist decision against the last-loaded policy. Call get()
  // first on an async path so the cache is warm. A role with no list is
  // unrestricted; a role WITH a list and an unreadable client address is denied.
  function checkIp(role, ip) {
    const policy = snapshot();
    const list = policy.ipAllowlist[role];
    if (!list || !list.length) return { allowed: true, restricted: false };
    const compiled = cached && cached.compiled[role] ? cached.compiled[role] : compileList(list.map(parseAllowEntry).filter(Boolean));
    const addr = normalizeIp(ip);
    if (!addr) return { allowed: false, restricted: true, reason: 'unknown-address' };
    return compiled.check(addr.address, addr.family)
      ? { allowed: true, restricted: true }
      : { allowed: false, restricted: true, reason: 'not-in-allowlist' };
  }

  return { get, snapshot, invalidate, checkIp, set };
}

module.exports = {
  SECURITY_DEFAULTS,
  PASSWORD_HISTORY_MAX,
  PASSWORD_MAX_AGE_MAX_DAYS,
  ALLOWLIST_MAX_PER_ROLE,
  normalizeIp,
  parseAllowEntry,
  ipInList,
  normalizeSecurity,
  validateSecurity,
  mergeSecurity,
  passwordExpiresAt,
  isPasswordExpired,
  passwordSetAt,
  createSecurityPolicy,
};
