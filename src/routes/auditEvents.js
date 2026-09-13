'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { toCsv } = require('../lib/csv');
const { CANONICAL_CATEGORIES, fromAuditEvent, fromAuditLog, mergeTrail } = require('../audit/categories');
const { buildUserActivity, summarize } = require('../audit/userActivity');
const { parseId } = require('../validation/locationValidation');

const ACTOR_TYPES = new Set(['user', 'agent', 'system']);

// Parses ?actorType=&action=&from=&to=&limit=&offset= into repo filters.
function parseQuery(q) {
  const filters = { limit: 100, offset: 0 };
  if (q.actorType && ACTOR_TYPES.has(q.actorType)) filters.actorType = q.actorType;
  if (q.action && typeof q.action === 'string') filters.action = q.action.slice(0, 96);
  for (const key of ['from', 'to']) {
    if (q[key]) { const d = new Date(q[key]); if (!Number.isNaN(d.getTime())) filters[key] = d; }
  }
  const limit = parseInt(q.limit, 10);
  if (Number.isInteger(limit) && limit > 0) filters.limit = Math.min(limit, 500);
  const offset = parseInt(q.offset, 10);
  if (Number.isInteger(offset) && offset > 0) filters.offset = offset;
  return filters;
}

// The unified, server-wide audit trail (Reporting → Audit). Admin only — this
// is the RBAC gate: only admins can see who did what on the server. Read-only;
// writes happen via the audit middleware (user actions) and on ingest (agent
// activity).
function createAuditEventsRouter({ auditEventsRepo, auditLogRepo = null, featureGate = null, usersRepo = null }) {
  const router = express.Router();
  const admin = requireRole(ROLES.ADMIN);

  // True when the licensed, hash-chained `audit_log` may be read as well.
  function auditLogReadable() {
    if (!auditLogRepo || typeof auditLogRepo.list !== 'function') return false;
    if (!featureGate || typeof featureGate.isFeatureEnabled !== 'function') return true;
    return featureGate.isFeatureEnabled('audit_log');
  }

  // id → { name, email, role } for the accounts that exist RIGHT NOW. Used only
  // to put a human name next to a row; a failure here must never take the log
  // down, so it degrades to "no names" rather than an error.
  async function userDirectory() {
    if (!usersRepo || typeof usersRepo.findAll !== 'function') return null;
    try {
      const users = await usersRepo.findAll();
      const out = {};
      for (const u of users || []) out[Number(u.id)] = { name: u.name || null, email: u.email || null, role: u.role || null };
      return out;
    } catch { return null; }
  }

  // The User Logs read model: every action a PERSON performed, resolved to
  // { userId, name, email }, described in plain language, and flagged when it
  // deserves a second look (see src/audit/userActivity.js).
  async function loadUserActivity(req) {
    const filters = parseQuery(req.query);
    const pageLimit = filters.limit;
    const events = auditEventsRepo ? await auditEventsRepo.findAll({ ...filters, actorType: 'user', limit: 500, offset: 0 }) : [];
    const logs = auditLogReadable() ? await auditLogRepo.list({ limit: 500 }) : [];
    const merged = mergeTrail(
      events.map(fromAuditEvent),
      logs.map(fromAuditLog),
      { actorType: 'user', limit: 1000, offset: 0 }
    );
    let rows = buildUserActivity(merged, { directory: await userDirectory() });

    // Post-filters that only make sense on the assembled rows.
    if (req.query.user !== undefined && req.query.user !== '') {
      const userId = parseId(req.query.user);
      if (userId === null) return { badRequest: 'Invalid user id' };
      rows = rows.filter((r) => r.userId === userId);
    }
    if (req.query.flagged === '1' || req.query.flagged === 'true') {
      rows = rows.filter((r) => r.flagLevel && r.flagLevel !== 'none');
    }
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const q = req.query.q.trim().toLowerCase();
      rows = rows.filter((r) => [r.name, r.email, r.action, r.actionLabel, r.target, r.ip, r.path]
        .some((v) => v && String(v).toLowerCase().includes(q)));
    }
    const summary = summarize(rows);
    const offset = filters.offset || 0;
    return { rows: rows.slice(offset, offset + pageLimit), summary, total: rows.length };
  }

  // GET /api/audit/users — User Logs. Admin only, same as the rest of the trail.
  router.get('/users', requireAuth, admin, asyncHandler(async (req, res) => {
    if (!auditEventsRepo && !auditLogReadable()) return res.status(503).json({ error: 'Audit log not available' });
    const result = await loadUserActivity(req);
    if (result.badRequest) return res.status(400).json({ error: result.badRequest });
    res.json({
      entries: result.rows,
      summary: result.summary,
      total: result.total,
      auditLogLicensed: auditLogReadable(),
    });
  }));

  // GET /api/audit/users/export.csv — the same rows, same filters, as a file.
  router.get('/users/export.csv', requireAuth, admin, asyncHandler(async (req, res) => {
    if (!auditEventsRepo && !auditLogReadable()) return res.status(503).json({ error: 'Audit log not available' });
    const result = await loadUserActivity(req);
    if (result.badRequest) return res.status(400).json({ error: result.badRequest });
    const rows = result.rows.map((r) => ({
      ts: r.ts,
      userId: r.userId,
      name: r.name,
      email: r.email,
      role: r.role,
      action: r.action,
      actionLabel: r.actionLabel,
      outcome: r.outcome,
      target: r.target,
      status: r.status,
      ip: r.ip,
      flagLevel: r.flagLevel === 'none' ? '' : r.flagLevel,
      flagReasons: r.flags.map((f) => f.message).join(' | '),
    }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="user-logs.csv"');
    res.send(toCsv(
      ['ts', 'userId', 'name', 'email', 'role', 'action', 'actionLabel', 'outcome', 'target', 'status', 'ip', 'flagLevel', 'flagReasons'],
      rows
    ));
  }));

  router.get('/', requireAuth, admin, asyncHandler(async (req, res) => {
    if (!auditEventsRepo) return res.status(503).json({ error: 'Audit log not available' });
    res.json(await auditEventsRepo.findAll(parseQuery(req.query)));
  }));

  // Unified audit trail: ONE timeline merging the two general stores
  // (`audit_events` + the licence-gated `audit_log`) onto the canonical shape, so
  // operators have a single "who did what" view instead of two. Read-only +
  // backward-compatible — the per-store endpoints (`/`, `/api/audit-log`) are
  // unchanged. audit_log rows are included only when its feature is licensed.
  router.get('/all', requireAuth, admin, asyncHandler(async (req, res) => {
    const filters = parseQuery(req.query);
    const category = typeof req.query.category === 'string' ? req.query.category.slice(0, 32) : null;
    const events = auditEventsRepo ? await auditEventsRepo.findAll({ ...filters, limit: 500 }) : [];

    let logs = [];
    if (auditLogReadable()) {
      logs = await auditLogRepo.list({ limit: 500 });
    }

    const entries = mergeTrail(
      events.map(fromAuditEvent),
      logs.map(fromAuditLog),
      { category, actorType: filters.actorType, limit: filters.limit, offset: filters.offset }
    );
    res.json({ entries, sources: { events: events.length, log: logs.length }, categories: CANONICAL_CATEGORIES });
  }));

  // Distinct action keys — powers the dashboard filter dropdown.
  router.get('/actions', requireAuth, admin, asyncHandler(async (req, res) => {
    if (!auditEventsRepo) return res.status(503).json({ error: 'Audit log not available' });
    res.json(await auditEventsRepo.distinctActions());
  }));

  // CSV export of the (filtered) trail.
  router.get('/export.csv', requireAuth, admin, asyncHandler(async (req, res) => {
    if (!auditEventsRepo) return res.status(503).json({ error: 'Audit log not available' });
    const filters = parseQuery(req.query);
    filters.limit = 500;
    const rows = await auditEventsRepo.findAll(filters);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
    res.send(toCsv(
      ['ts', 'actorType', 'actorLabel', 'actorRole', 'action', 'targetType', 'targetId', 'occurrences', 'repeatIntervalMs', 'method', 'path', 'status', 'ip'],
      rows
    ));
  }));

  return router;
}

module.exports = { createAuditEventsRouter };
