'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { buildClusterDetail } = require('../analysis/clusterView');

// Cross-agent incident CLUSTERS (incident_clusters) — findings from ≥2 agents that
// fired together, grouped by the clustering engine (src/analysis/crossAgent*).
//
//   GET  /api/incident-clusters          viewer+   list (filter status/time, paged)
//   GET  /api/incident-clusters/:id      viewer+   full cluster: members, evidence,
//                                                   confidence breakdown, root cause
//   POST /api/incident-clusters/:id/ack      operator+  acknowledge (audited)
//   POST /api/incident-clusters/:id/resolve  operator+  resolve + required note (audited)
//
// NOTE ON THE MOUNT PATH: the task asked for `/api/incidents`, but that path is
// already the first-class `incident_cases` router (a DISTINCT feature). Clusters
// therefore live at `/api/incident-clusters`, matching how CODEMAP already names
// this feature. Same verbs/shapes as specified.
//
// RBAC mirrors the rest of the platform: reads are viewer+, state changes
// (ack/resolve) are operator/admin. Every state change is recorded in the
// hash-chained audit_log via the injected auditLogger (as src/routes/incidents.js).

const VALID_STATUSES = ['open', 'acknowledged', 'resolved', 'closed'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseDate(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Bounded non-negative integer from a query param, or the fallback.
function parseIntParam(raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null; // signals a 400
  return n;
}

function createIncidentClustersRouter({ clustersRepo, findingStore = null, auditLogger = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const writer = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  // GET /api/incident-clusters — filterable, paginated list. viewer+.
  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    const { status } = req.query;
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'invalid status filter', allowed: VALID_STATUSES });
    }
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (req.query.from && !from) return res.status(400).json({ error: 'invalid from date' });
    if (req.query.to && !to) return res.status(400).json({ error: 'invalid to date' });

    const limit = parseIntParam(req.query.limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });
    const offset = parseIntParam(req.query.offset, 0, { min: 0 });
    if (limit === null) return res.status(400).json({ error: `limit must be 1..${MAX_LIMIT}` });
    if (offset === null) return res.status(400).json({ error: 'offset must be >= 0' });

    const filter = { status: status || null, from, to };
    const [clusters, total] = await Promise.all([
      clustersRepo.list({ ...filter, limit, offset }),
      typeof clustersRepo.count === 'function' ? clustersRepo.count(filter) : Promise.resolve(null),
    ]);

    return res.json({ clusters, page: { limit, offset, total } });
  }));

  // Hydrates a cluster's member findings, preserving member order and dropping
  // any that no longer exist (retention may have purged them).
  async function hydrateMembers(memberFindingIds) {
    if (!findingStore || typeof findingStore.get !== 'function') return [];
    const out = [];
    for (const id of memberFindingIds || []) {
      const f = await findingStore.get(id); // eslint-disable-line no-await-in-loop
      if (f) out.push(f);
    }
    return out;
  }

  // GET /api/incident-clusters/:id — full cluster with members, evidence,
  // confidence breakdown and suspected root-cause layer. viewer+.
  router.get('/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const cluster = await clustersRepo.findById(id);
    if (!cluster) return res.status(404).json({ error: 'Incident cluster not found' });

    const members = await hydrateMembers(cluster.memberFindingIds);
    return res.json({ cluster: buildClusterDetail(cluster, members) });
  }));

  // POST /api/incident-clusters/:id/ack — acknowledge (operator+). Audited.
  router.post('/:id/ack', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    const existing = await clustersRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Incident cluster not found' });

    const ok = await clustersRepo.acknowledge(id, { by: (req.user && req.user.id) || null, at: new Date() });
    if (!ok) {
      // Only an OPEN cluster can be acknowledged; anything else is a conflict.
      return res.status(409).json({ error: `Cannot acknowledge a cluster in status "${existing.status}"` });
    }

    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'incident', action: 'cluster_acknowledge', target: String(id),
        detail: `open→acknowledged (${existing.memberFindingIds.length} members)`,
      });
    }

    const updated = await clustersRepo.findById(id);
    return res.json({ cluster: updated });
  }));

  // POST /api/incident-clusters/:id/resolve — resolve with a REQUIRED free-text
  // note (operator+). Audited.
  router.post('/:id/resolve', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    const note = typeof (req.body || {}).note === 'string' ? req.body.note.trim() : '';
    if (note === '') {
      return res.status(400).json({ error: 'Validation failed', details: { note: 'a resolution note is required' } });
    }

    const existing = await clustersRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Incident cluster not found' });

    const ok = await clustersRepo.resolve(id, { by: (req.user && req.user.id) || null, note, at: new Date() });
    if (!ok) {
      // Already resolved/closed, or a concurrent change.
      return res.status(409).json({ error: `Cannot resolve a cluster in status "${existing.status}"` });
    }

    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'incident', action: 'cluster_resolve', target: String(id),
        detail: `${existing.status}→resolved: ${note.slice(0, 200)}`,
      });
    }

    const updated = await clustersRepo.findById(id);
    return res.json({ cluster: updated });
  }));

  return router;
}

module.exports = { createIncidentClustersRouter };
