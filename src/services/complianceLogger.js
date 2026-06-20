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

function createAuditLogger({ auditLogRepo = null, logger = console } = {}) {
  const enabled = Boolean(auditLogRepo && typeof auditLogRepo.record === 'function');

  // Records one event. `req` may be null for system-originated events. Any
  // explicit actor*/ip in `event` overrides what is read off the request.
  async function record(req, event = {}) {
    if (!enabled) return null;
    try {
      const user = (req && req.user) || {};
      return await auditLogRepo.record({
        category: event.category,
        action: event.action,
        outcome: event.outcome || 'success',
        actorUserId: event.actorUserId !== undefined ? event.actorUserId : (user.id ?? null),
        actorEmail: event.actorEmail !== undefined ? event.actorEmail : (user.email ?? null),
        actorRole: event.actorRole !== undefined ? event.actorRole : (user.role ?? null),
        target: event.target ?? null,
        detail: event.detail ?? null,
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

module.exports = { createAuditLogger, clientIp };
