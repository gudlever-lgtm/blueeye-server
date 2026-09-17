'use strict';

// USER ACTIVITY — the read model behind Administration → User Logs.
//
// The dashboard's Logs menu is split in two because the two things under it are
// not the same kind of record and are not read for the same reason:
//
//   System Logs  the server's own diagnostic stream (in-memory, cleared on
//                restart) — "is the server healthy?"
//   User Logs    who did what, when, and whether it looks wrong — "what did
//                people do here?" Durable, drawn from the audit stores.
//
// This module is the User Logs half, and it is PURE: entries in, annotated
// entries out, no I/O. It takes the canonical audit shape produced by
// audit/categories.js (fromAuditEvent / fromAuditLog), keeps only the rows a
// PERSON caused, resolves the actor to { userId, name, email, role }, and
// flags the ones worth a second look.
//
// FLAGGING, and why it is rule-based. Every flag carries its own sentence
// explaining why it fired, in the same spirit as the analysis engine: a marker
// nobody can explain is a marker nobody trusts. There is no scoring model and
// no threshold anyone has to tune — six rules, each one a fact about the row or
// about that user's other rows in the same window.
//
// A flag is NOT an accusation. It means "this deserves a look": a delete is
// flagged because it cannot be undone, not because it was wrong.

const { categoryOf } = require('./categories');

// Severity ladder. `none` is not a flag — it is the absence of one.
const FLAG_LEVELS = { none: 0, notice: 1, warn: 2, critical: 3 };

// How many failed sign-ins by one user, inside how long a window, reads as an
// attempt to get in rather than a fat-fingered password.
const FAILED_LOGIN_BURST = 3;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

// Action keys whose effect cannot be taken back. Matched on the verb, so both
// spellings in the two stores are covered (`user.delete` and `user_delete`).
const DESTRUCTIVE_VERBS = new Set(['delete', 'remove', 'purge', 'revoke', 'reset', 'wipe']);

// Actions that change who can do what, or what the server trusts. These are the
// ones a reviewer wants to see even when they succeeded exactly as intended.
const PRIVILEGED_ACTION_RE =
  /(user|role|rbac|token|api[-_]?key|licen[sc]e|ldap|oidc|saml|sso|password|permission|allowlist|secret)/i;

// Plain-language verbs. The stores disagree on separator (`user.update` in
// audit_events, `user_update` in audit_log), so both are normalised first.
const VERB_LABELS = {
  create: 'Created', update: 'Updated', delete: 'Deleted', remove: 'Removed',
  login: 'Signed in', logout: 'Signed out', upload: 'Uploaded', export: 'Exported',
  run: 'Ran', upgrade: 'Upgraded', resend: 'Re-sent', revoke: 'Revoked', reset: 'Reset',
  revalidate: 'Re-validated',
};

// Resource names as a person would say them.
const RESOURCE_LABELS = {
  auth: 'session', user: 'user', agent: 'agent', location: 'site',
  'enrollment-code': 'enrollment code', 'api-token': 'API token', license: 'licence',
  settings: 'settings', integration: 'integration', threshold: 'threshold',
  report: 'report', profile: 'own profile', nis2: 'NIS2 record', alerting: 'alerting',
  'test-package': 'test package', assistant: 'assistant',
};

// Splits an action key into { resource, verb } regardless of separator.
function splitAction(action) {
  const parts = String(action || '').split(/[._]/).filter(Boolean);
  if (parts.length === 0) return { resource: null, verb: null };
  if (parts.length === 1) return { resource: parts[0], verb: null };
  return { resource: parts[0], verb: parts[1], rest: parts.slice(2) };
}

// A readable sentence for the action column. Falls back to the raw key with its
// separators opened up, so an action this module has never heard of is still
// legible instead of blank.
function describeAction(action) {
  const { resource, verb, rest = [] } = splitAction(action);
  if (!resource) return '—';
  if (resource === 'auth' && (verb === 'login' || verb === 'logout')) return VERB_LABELS[verb];
  const v = VERB_LABELS[verb];
  const r = RESOURCE_LABELS[resource] || String(resource).replace(/[-_]/g, ' ');
  if (!v) return `${r}${verb ? ` — ${[verb, ...rest].join(' ').replace(/[-_]/g, ' ')}` : ''}`;
  const suffix = rest.length ? ` (${rest.join(' ').replace(/[-_]/g, ' ')})` : '';
  return `${v} ${r}${suffix}`;
}

// Was this entry caused by a person? audit_log only ever records users;
// audit_events records agents and the system too, and those belong in the
// system half of the split, not here.
function isUserEntry(entry) {
  return Boolean(entry && entry.actor && entry.actor.type === 'user');
}

function tsMs(entry) {
  const t = Date.parse(entry && entry.ts ? entry.ts : '');
  return Number.isNaN(t) ? 0 : t;
}

// --- the rules -------------------------------------------------------------
// Each returns a flag object or null. `history` is what this same user did
// EARLIER in the window being rendered (oldest-first), which is what lets a
// rule talk about a burst or an address rather than a single row.

function deniedRule(entry) {
  if (entry.outcome !== 'denied' && entry.status !== 403) return null;
  return {
    code: 'denied',
    level: 'critical',
    message: 'Refused: the user attempted something their role does not allow.',
  };
}

function failureRule(entry) {
  const status = entry.status == null ? null : Number(entry.status);
  if (status != null && status >= 500) {
    return { code: 'server-error', level: 'warn', message: `The server failed while doing this (HTTP ${status}) — the action may be half-applied.` };
  }
  if (entry.outcome !== 'failure' && !(status != null && status >= 400)) return null;
  if (status != null && status >= 400) {
    return { code: 'rejected', level: 'warn', message: `The server rejected this (HTTP ${status}) — it did not take effect.` };
  }
  return { code: 'failed', level: 'warn', message: 'The action did not succeed.' };
}

function failedLoginBurstRule(entry, history) {
  const isLogin = categoryOf(entry.action) === 'auth' || /login/i.test(String(entry.action || ''));
  if (!isLogin) return null;
  if (entry.outcome === 'success') return null;
  const since = tsMs(entry) - FAILED_LOGIN_WINDOW_MS;
  const recentFailures = history.filter((h) =>
    tsMs(h) >= since
    && h.outcome !== 'success'
    && (categoryOf(h.action) === 'auth' || /login/i.test(String(h.action || '')))).length + 1;
  if (recentFailures < FAILED_LOGIN_BURST) return null;
  return {
    code: 'failed-login-burst',
    level: 'critical',
    message: `${recentFailures} failed sign-ins for this account within ${Math.round(FAILED_LOGIN_WINDOW_MS / 60000)} minutes.`,
  };
}

function destructiveRule(entry) {
  const { verb } = splitAction(entry.action);
  if (!verb || !DESTRUCTIVE_VERBS.has(verb)) return null;
  if (entry.outcome !== 'success') return null; // already covered by failureRule
  return {
    code: 'destructive',
    level: 'notice',
    message: 'Irreversible: this removed or reset something and cannot be undone from here.',
  };
}

function privilegedRule(entry) {
  if (!PRIVILEGED_ACTION_RE.test(String(entry.action || ''))) return null;
  if (categoryOf(entry.action) === 'auth' && /login|logout/i.test(String(entry.action))) return null;
  if (entry.outcome !== 'success') return null;
  return {
    code: 'privileged',
    level: 'notice',
    message: 'Changes access or trust (accounts, roles, tokens, licence or sign-in configuration).',
  };
}

// A sign-in from an address this account has not used elsewhere in the same
// window. Deliberately narrow: it only fires when there IS earlier activity to
// compare against, so the first row for a user is never flagged as "new".
function newAddressRule(entry, history) {
  if (!entry.ip) return null;
  const isLogin = categoryOf(entry.action) === 'auth' || /login/i.test(String(entry.action || ''));
  if (!isLogin) return null;
  const seen = history.filter((h) => h.ip).map((h) => h.ip);
  if (seen.length === 0 || seen.includes(entry.ip)) return null;
  return {
    code: 'new-address',
    level: 'notice',
    message: `Signed in from ${entry.ip}, an address this account has not used elsewhere in this view.`,
  };
}

const RULES = [deniedRule, failureRule, failedLoginBurstRule, destructiveRule, privilegedRule, newAddressRule];

// Runs every rule over one entry and folds the results into a single verdict:
// the highest level that fired, plus every reason, so the UI can show one badge
// and the full explanation behind it.
function flagsFor(entry, history = []) {
  const flags = [];
  for (const rule of RULES) {
    const flag = rule(entry, history);
    if (flag) flags.push(flag);
  }
  const level = flags.reduce((acc, f) => (FLAG_LEVELS[f.level] > FLAG_LEVELS[acc] ? f.level : acc), 'none');
  return { level, flags };
}

// Resolves the actor of an entry against a { [userId]: { name, email, role } }
// directory. The trail stores the email AS IT WAS at the time and that is what
// stays authoritative for identity; the name is looked up live, because a name
// is a label — an admin correcting a spelling should fix it everywhere, and a
// deleted account should still show the address that acted.
function resolveActor(entry, directory) {
  const id = entry.actor && entry.actor.id != null ? Number(entry.actor.id) : null;
  const known = id != null && directory ? directory[id] : null;
  const email = (entry.actor && entry.actor.label) || (known && known.email) || null;
  return {
    userId: id,
    name: (known && known.name) || null,
    email,
    role: (entry.actor && entry.actor.role) || (known && known.role) || null,
    // True when the id no longer resolves — the account was deleted since. The
    // row stays, because deleting a user must not erase what they did.
    deletedUser: id != null && Boolean(directory) && !known,
  };
}

// The public entry point: canonical entries (any order) → the User Logs rows,
// newest first. `directory` maps user id → { name, email, role }.
//
// Rules that need context (a burst, a new address) read the user's EARLIER rows,
// so the list is walked oldest-first before being reversed for display.
function buildUserActivity(entries, { directory = null, limit = null } = {}) {
  const userEntries = (Array.isArray(entries) ? entries : [])
    .filter(isUserEntry)
    .slice()
    .sort((a, b) => tsMs(a) - tsMs(b));

  const historyByUser = new Map();
  const rows = userEntries.map((entry) => {
    const actor = resolveActor(entry, directory);
    const key = actor.userId != null ? `id:${actor.userId}` : `email:${actor.email || 'unknown'}`;
    const history = historyByUser.get(key) || [];
    const { level, flags } = flagsFor(entry, history);
    history.push(entry);
    historyByUser.set(key, history);
    return {
      id: entry.id,
      source: entry.source,
      ts: entry.ts,
      userId: actor.userId,
      name: actor.name,
      email: actor.email,
      role: actor.role,
      deletedUser: actor.deletedUser,
      category: entry.category,
      action: entry.action,
      actionLabel: describeAction(entry.action),
      outcome: entry.outcome,
      target: (entry.target && (entry.target.label || entry.target.id)) || null,
      targetType: (entry.target && entry.target.type) || null,
      method: entry.method || null,
      path: entry.path || null,
      status: entry.status == null ? null : Number(entry.status),
      ip: entry.ip || null,
      detail: entry.detail ?? null,
      occurrences: entry.occurrences == null ? 1 : Number(entry.occurrences),
      flagLevel: level,
      flags,
    };
  });

  rows.reverse();
  return limit && limit > 0 ? rows.slice(0, limit) : rows;
}

// Tally of each flag level over a set of rows — the counters above the table.
function summarize(rows) {
  const out = { total: rows.length, critical: 0, warn: 0, notice: 0, flagged: 0, users: 0 };
  const users = new Set();
  for (const r of rows) {
    if (r.flagLevel && r.flagLevel !== 'none') { out.flagged += 1; out[r.flagLevel] += 1; }
    users.add(r.userId != null ? `id:${r.userId}` : `email:${r.email || 'unknown'}`);
  }
  out.users = users.size;
  return out;
}

module.exports = {
  FLAG_LEVELS,
  FAILED_LOGIN_BURST,
  FAILED_LOGIN_WINDOW_MS,
  buildUserActivity,
  describeAction,
  flagsFor,
  isUserEntry,
  splitAction,
  summarize,
};
