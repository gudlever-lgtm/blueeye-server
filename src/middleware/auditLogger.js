'use strict';

const { describeRequest, redactBody, isMutating } = require('../audit/actions');

const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // mirror agents.js cap

// Records server-wide user actions in the unified audit trail. Mounted early
// (before the API router) but it records in res.on('finish') — by then the
// route's requireAuth has populated req.user, so we know WHO acted.
//
// What it records: successful (2xx) state-changing requests (POST/PUT/PATCH/
// DELETE) made by an authenticated user, plus successful logins (which have no
// req.user yet). Agent-token endpoints have no req.user and are skipped here —
// agent activity is audited separately on ingest. Everything is best-effort: a
// failure to audit must never affect the response.
function createAuditLogger({ auditRepo, logger = null } = {}) {
  // Paths we never audit, even when mutating: the audit reader itself and the
  // agent self-report endpoints (those are audited on ingest, not as HTTP).
  function skip(req) {
    const p = req.path || req.originalUrl || '';
    if (p.startsWith('/api/audit')) return true;
    if (p.startsWith('/agents/results') || p.startsWith('/agents/probe-results')) return true;
    if (p.startsWith('/agents/me/')) return true;
    if (p === '/agents/enroll' || p.startsWith('/agents/enroll')) return true;
    return false;
  }

  function clientIp(req) {
    const xff = req.headers && req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim().slice(0, 64);
    return (req.ip || (req.socket && req.socket.remoteAddress) || '').slice(0, 64) || null;
  }

  return function auditLogger(req, res, next) {
    if (!auditRepo) return next();
    if (!isMutating(req.method)) return next();

    const path = req.path || (req.originalUrl || '').split('?')[0];
    if (skip(req)) return next();

    // Snapshot the body now — downstream handlers may mutate it.
    const bodySnapshot = redactBody(req.body);
    const isLogin = path === '/auth' || path === '/auth/' || path.startsWith('/auth');
    // For login the actor identity comes from the posted email (no JWT yet).
    const loginEmail = isLogin && req.body && typeof req.body.email === 'string'
      ? req.body.email.slice(0, 255) : null;
    // A user-triggered repeating test/probe carries an intervalMs in the body.
    const intervalMs = req.body && Number.isInteger(req.body.intervalMs)
      && req.body.intervalMs > 0 && req.body.intervalMs <= MAX_INTERVAL_MS
      ? req.body.intervalMs : null;

    res.on('finish', () => {
      try {
        // Only successful state changes are auditable activity.
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        // Authenticated user action, or a successful login. Anything else
        // (agent token, unauthenticated) is not a user action.
        const user = req.user || null;
        if (!user && !isLogin) return;

        const desc = describeRequest(req.method, path);
        if (!desc) return;

        Promise.resolve(auditRepo.record({
          actorType: 'user',
          actorId: user ? user.id : null,
          actorLabel: user ? user.email : loginEmail,
          actorRole: user ? user.role : null,
          action: desc.action,
          targetType: desc.targetType,
          targetId: desc.targetId,
          targetLabel: desc.targetLabel,
          method: req.method,
          path: path.slice(0, 255),
          status: res.statusCode,
          ip: clientIp(req),
          detail: bodySnapshot,
          repeatIntervalMs: intervalMs,
        })).catch((err) => { if (logger) logger.warn(`audit: ${err.message}`); });
      } catch (err) {
        if (logger) logger.warn(`audit: ${err.message}`);
      }
    });

    return next();
  };
}

module.exports = { createAuditLogger };
