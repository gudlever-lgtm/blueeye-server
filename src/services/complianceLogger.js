'use strict';

// Thin, fail-safe wrapper over auditLogRepository used by routes to record
// security/administrative events. Two jobs:
//   1. Never let an audit failure break the request it describes — record()
//      swallows and logs errors instead of throwing.
//   2. Pull the actor (req.user) and source IP off an Express request so call
//      sites stay one-liners.
//
//   const audit = createAuditLogger({ auditLogRepo, logger });
//   await audit.record(req, { category: 'user', action: 'user_create', target: email });
//
// Privacy by design: callers pass metadata only — never passwords/tokens/payloads.
function clientIp(req) {
  if (!req) return null;
  // Use req.ip (Express, respects app trust-proxy setting) so raw
  // X-Forwarded-For headers can't be spoofed when TRUST_PROXY=false.
  return (req.ip || (req.socket && req.socket.remoteAddress) || null);
}

const nonEmpty = (v) => (v == null ? null : (String(v).trim() || null));

// Normalises one event into the shape audit_log stores, or explains why it
// cannot. Two call shapes exist in this codebase and only one of them is this
// logger's: `{ category, action, target, detail }` here, and
// `{ action, targetType, targetId, targetLabel }` — the audit_EVENTS shape
// (auditEventsRepository). A route that handed the second shape to this logger
// wrote nothing at all: `category` is NOT NULL, the INSERT failed, and the
// only trace was "WARN audit_log record failed: Column 'category' cannot be
// null" — SNMP device and credential-profile changes never reached the
// hash-chained trail. So the second shape is TRANSLATED rather than lost:
//   * category — given, else the dotted action's first segment
//     (`snmp_device.create` → `snmp_device`, the rule audit/categories.js uses
//     on the read side), else the targetType;
//   * target — given, else targetId, else targetLabel;
//   * detail — given, else the targetLabel when the id became the target.
// What still has no action or no category is refused with the reason.
function normaliseAuditEvent(event) {
  const e = event && typeof event === 'object' ? event : {};
  const action = nonEmpty(e.action);
  if (!action) return { error: 'audit event has no action' };
  const dotted = action.includes('.') ? nonEmpty(action.split('.')[0]) : null;
  const category = nonEmpty(e.category) || dotted || nonEmpty(e.targetType);
  if (!category) return { error: `audit event "${action}" has no category` };
  const targetId = nonEmpty(e.targetId);
  const targetLabel = nonEmpty(e.targetLabel);
  const target = e.target != null ? String(e.target) : (targetId || targetLabel);
  const detail = e.detail != null ? e.detail : (targetId && targetLabel ? targetLabel : null);
  return { value: { category, action, target: target ?? null, detail: detail ?? null } };
}

// `strict` makes an event that cannot be normalised THROW instead of being
// logged and dropped. Tests wire the logger strict (test-support/fakes.js), so
// a malformed call fails the route test that exercises it rather than
// surfacing, as this one did, as a runtime warning in a field run. Production
// stays best-effort: an audit failure never breaks the request it describes.
function createAuditLogger({ auditLogRepo = null, logger = console, strict = false } = {}) {
  const enabled = Boolean(auditLogRepo && typeof auditLogRepo.record === 'function');

  // Records one event. `req` may be null for system-originated events. Any
  // explicit actor*/ip in `event` overrides what is read off the request.
  async function record(req, event = {}) {
    if (!enabled) return null;
    const { value, error } = normaliseAuditEvent(event);
    if (error) {
      if (strict) throw new TypeError(`audit_log: ${error}`);
      try { logger.warn && logger.warn(`audit_log record skipped: ${error}`); } catch { /* ignore */ }
      return null;
    }
    try {
      const user = (req && req.user) || {};
      return await auditLogRepo.record({
        category: value.category,
        action: value.action,
        outcome: event.outcome || 'success',
        actorUserId: event.actorUserId !== undefined ? event.actorUserId : (user.id ?? null),
        actorEmail: event.actorEmail !== undefined ? event.actorEmail : (user.email ?? null),
        actorRole: event.actorRole !== undefined ? event.actorRole : (user.role ?? null),
        target: value.target,
        detail: value.detail,
        ip: event.ip !== undefined ? event.ip : clientIp(req),
      });
    } catch (err) {
      // Audit is best-effort: log and move on so the underlying action still
      // succeeds and is reported to the caller.
      try { logger.warn && logger.warn(`audit_log record failed: ${err.message}`); } catch { /* ignore */ }
      return null;
    }
  }

  return { record, enabled };
}

module.exports = { createAuditLogger, clientIp, normaliseAuditEvent };
