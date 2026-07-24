'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');

// Scheduled active-discovery admin API. EVERY endpoint is ADMIN-only — viewer and
// operator get 403 (requireRole(ADMIN), no role hierarchy). Candidates are never
// auto-enrolled; promotion (admin) is the only path that creates a monitored
// device. Mounted at /api/discovery.
function createDiscoveryRouter({ discoveredDevicesRepo, agentsRepo = null, discoverySweepJob = null, auditLogger = null, config = null }) {
  const router = express.Router();
  router.use(requireAuth, requireRole(ROLES.ADMIN));

  const STATUSES = ['discovered', 'promoted', 'ignored'];

  // Effective scan configuration (no secrets — scope/ports/limits only).
  router.get('/config', asyncHandler(async (req, res) => {
    const c = config || {};
    res.json({
      enabled: !!c.enabled,
      cidrs: c.cidrs || [],
      ports: c.ports || [],
      rateLimit: c.rateLimit ?? null,
      addressCap: c.addressCap ?? null,
      intervalMinutes: c.intervalMinutes ?? null,
    });
  }));

  // List candidates (optionally by status).
  router.get('/candidates', asyncHandler(async (req, res) => {
    let status = null;
    if (req.query.status !== undefined && req.query.status !== '') {
      status = String(req.query.status);
      if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }
    const limRaw = req.query.limit;
    const limit = limRaw === undefined || limRaw === '' ? 200 : Number(limRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) return res.status(400).json({ error: 'limit must be 1..2000' });
    const [candidates, counts] = await Promise.all([
      discoveredDevicesRepo.list({ status, limit }),
      typeof discoveredDevicesRepo.countByStatus === 'function' ? discoveredDevicesRepo.countByStatus() : Promise.resolve(null),
    ]);
    res.json({ candidates, counts });
  }));

  router.get('/candidates/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const row = await discoveredDevicesRepo.findById(id);
    if (!row) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ candidate: row });
  }));

  // Run a sweep now (normally scheduled). 503 when no job is wired.
  router.post('/scan', asyncHandler(async (req, res) => {
    if (!discoverySweepJob || typeof discoverySweepJob.run !== 'function') {
      return res.status(503).json({ error: 'Discovery job not available' });
    }
    const result = await discoverySweepJob.run();
    res.json({ ok: true, ...(result || {}) });
  }));

  // Promote a candidate → create a monitored SNMP device. Admin only.
  router.post('/candidates/:id/promote', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const cand = await discoveredDevicesRepo.findById(id);
    if (!cand) return res.status(404).json({ error: 'Candidate not found' });
    if (cand.status === 'promoted') return res.json({ ok: true, alreadyPromoted: true, agentId: cand.promotedAgentId });
    if (!agentsRepo || typeof agentsRepo.insertSnmpDevice !== 'function') return res.status(503).json({ error: 'Agent registration not available' });

    const agentId = await agentsRepo.insertSnmpDevice({ hostname: cand.hostname || cand.ip, host: cand.ip });
    await discoveredDevicesRepo.setStatus(id, 'promoted', { promotedAgentId: agentId });
    if (auditLogger) await auditLogger.record(req, { category: 'discovery', action: 'discovery_promote', target: cand.ip, detail: `agent=${agentId}` });
    res.json({ ok: true, agentId });
  }));

  // Ignore a candidate (a later sweep won't resurrect it). Admin only.
  router.post('/candidates/:id/ignore', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const cand = await discoveredDevicesRepo.findById(id);
    if (!cand) return res.status(404).json({ error: 'Candidate not found' });
    await discoveredDevicesRepo.setStatus(id, 'ignored');
    if (auditLogger) await auditLogger.record(req, { category: 'discovery', action: 'discovery_ignore', target: cand.ip });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createDiscoveryRouter };
