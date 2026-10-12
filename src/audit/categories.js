'use strict';

// Canonical audit taxonomy + normalizers — the read-side consolidation of the
// two general audit stores (see docs/audit-vs-logging.md). BlueEye currently
// persists audit events in two tables with different shapes:
//   - `audit_events` (auditEventsRepository) — auto-captured user actions + agent
//     activity; HTTP method/path/status, dedup `occurrences`, action is dotted
//     (`user.update`), no explicit category/outcome.
//   - `audit_log` (auditLogRepository) — the hash-chained compliance trail; has
//     explicit category + outcome, no HTTP/target-type detail.
// Rather than a risky physical table merge, these normalizers map BOTH onto one
// canonical shape so a single endpoint can present one timeline. The write side
// and both existing endpoints are unchanged.

// The canonical event shape:
//   { source, id, ts, category, action, outcome,
//     actor:{type,id,label,role}, target:{type,id,label},
//     ip, detail, method, path, status, occurrences }

// Reference list of top-level categories used across the trail (for the UI filter
// and documentation). Derived from the resources in audit/actions.js plus the
// audit_log categories (auth/license/report/api-token/…) and agent/integration/
// sso/nis2 activity. Not an enforcement gate — categories are derived per event.
const CANONICAL_CATEGORIES = [
  'auth', 'user', 'agent', 'location', 'enrollment-code', 'license', 'settings',
  'integration', 'ldap', 'sso', 'oidc', 'saml', 'nis2', 'alerting', 'threshold',
  'test-package', 'assistant', 'api-token', 'report', 'system',
];

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// Top-level category from a dotted action key (`agent.run-test` -> `agent`).
function categoryOf(action) {
  return typeof action === 'string' && action.includes('.') ? action.split('.')[0] : null;
}

// Normalize an `audit_events` row (already camelCase-mapped by its repository).
function fromAuditEvent(row) {
  const status = row.status == null ? null : Number(row.status);
  return {
    source: 'events',
    id: `events:${row.id}`,
    ts: row.lastSeenAt || row.ts || null,
    category: categoryOf(row.action) || row.actorType || 'event',
    action: row.action ?? null,
    // audit_events only records successful (2xx) user actions; a 4xx/5xx slipping
    // in is surfaced as a failure for a uniform outcome field.
    outcome: status != null && status >= 400 ? 'failure' : 'success',
    actor: { type: row.actorType ?? null, id: row.actorId ?? null, label: row.actorLabel ?? null, role: row.actorRole ?? null },
    target: { type: row.targetType ?? null, id: row.targetId ?? null, label: row.targetLabel ?? null },
    ip: row.ip ?? null,
    detail: row.detail ?? null,
    method: row.method ?? null,
    path: row.path ?? null,
    status,
    occurrences: row.occurrences == null ? 1 : Number(row.occurrences),
  };
}

// Normalize an `audit_log` row (raw snake_case from its repository's list()).
function fromAuditLog(row) {
  return {
    source: 'log',
    id: `log:${row.id}`,
    ts: toIso(row.created_at),
    category: row.category ?? null,
    action: row.action ?? null,
    outcome: row.outcome ?? 'success',
    actor: { type: 'user', id: row.actor_user_id ?? null, label: row.actor_email ?? null, role: row.actor_role ?? null },
    target: { type: null, id: null, label: row.target ?? null },
    ip: row.ip ?? null,
    detail: row.detail ?? null,
    method: null,
    path: null,
    status: null,
    occurrences: 1,
  };
}

// Merge already-normalized entries from both stores into one timeline, newest
// first, with optional category/actorType filters and limit/offset paging.
function mergeTrail(events, logs, { category = null, actorType = null, limit = 100, offset = 0 } = {}) {
  const merged = [...events, ...logs]
    .filter((e) => !category || e.category === category)
    .filter((e) => !actorType || (e.actor && e.actor.type === actorType))
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const lim = Number.isInteger(limit) && limit > 0 ? limit : 100;
  return merged.slice(off, off + lim);
}

module.exports = { CANONICAL_CATEGORIES, categoryOf, fromAuditEvent, fromAuditLog, mergeTrail };
