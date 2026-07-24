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
function createDiscoveryRouter({ discoveredDevicesRepo, agentsRepo = null, discoverySweepJob = null, auditLogger = null, auditLogRepo = null, config = null, getConfig = null, setConfig = null }) {
  const router = express.Router();
  router.use(requireAuth, requireRole(ROLES.ADMIN));

  const STATUSES = ['discovered', 'promoted', 'ignored'];
  // Effective config comes from the settings-backed provider when wired (so the
  // admin can edit scope in the UI); otherwise the static env config.
  const effectiveConfig = async () => (getConfig ? await getConfig() : (config || {}));

  // Effective scan configuration (no secrets — scope/ports/limits only).
  router.get('/config', asyncHandler(async (req, res) => {
    const c = await effectiveConfig();
    res.json({
      enabled: !!c.enabled,
      cidrs: c.cidrs || [],
      ports: c.ports || [],
      rateLimit: c.rateLimit ?? null,
      addressCap: c.addressCap ?? null,
      intervalMinutes: c.intervalMinutes ?? null,
      source: c.source || null,
      scopeConfigured: c.scopeConfigured != null ? c.scopeConfigured : (c.cidrs || []).length > 0,
      editable: !!setConfig,
    });
  }));

  // Update the scan scope (CIDRs / ports / rate / cap / interval). Admin only.
  // 503 when no settings-backed provider is wired; 400 on validation failure.
  router.put('/config', asyncHandler(async (req, res) => {
    if (!setConfig) return res.status(503).json({ error: 'Discovery config is read-only (env-managed)' });
    let effective;
    try {
      effective = await setConfig(req.body || {});
    } catch (err) {
      if (err && err.statusCode === 400) return res.status(400).json({ error: err.message, details: err.details || null });
      throw err;
    }
    if (auditLogger) await auditLogger.record(req, { category: 'discovery', action: 'discovery_config', detail: `cidrs=${(effective.cidrs || []).length} ports=${(effective.ports || []).length}` });
    res.json({ ok: true, config: effective });
  }));

  // Recent sweeps (from the hash-chained audit log; category 'discovery').
  router.get('/sweeps', asyncHandler(async (req, res) => {
    const limRaw = req.query.limit;
    const limit = limRaw === undefined || limRaw === '' ? 50 : Number(limRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return res.status(400).json({ error: 'limit must be 1..500' });
    if (!auditLogRepo || typeof auditLogRepo.list !== 'function') return res.json({ sweeps: [] });
    const rows = await auditLogRepo.list({ category: 'discovery', limit });
    const sweeps = rows
      .filter((r) => r.action === 'discovery_sweep' || r.action === 'discovery_sweep_refused')
      .map((r) => ({ createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, action: r.action, target: r.target ?? null, detail: r.detail ?? null }));
    res.json({ sweeps });
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
