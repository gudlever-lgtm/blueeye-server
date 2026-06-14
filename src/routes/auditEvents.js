'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { toCsv } = require('../lib/csv');
const { CANONICAL_CATEGORIES, fromAuditEvent, fromAuditLog, mergeTrail } = require('../audit/categories');

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
function createAuditEventsRouter({ auditEventsRepo, auditLogRepo = null, featureGate = null }) {
  const router = express.Router();
  const admin = requireRole(ROLES.ADMIN);

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

    const logLicensed = !featureGate || typeof featureGate.isFeatureEnabled !== 'function' || featureGate.isFeatureEnabled('audit_log');
    let logs = [];
    if (auditLogRepo && typeof auditLogRepo.list === 'function' && logLicensed) {
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
