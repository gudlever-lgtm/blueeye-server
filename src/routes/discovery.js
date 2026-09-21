'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { intOrNull } = require('../lib/num');

// Scheduled active-discovery admin API. EVERY endpoint is ADMIN-only — viewer and
// operator get 403 (requireRole(ADMIN), no role hierarchy). Candidates are never
// auto-enrolled; promotion (admin) is the only path that creates a monitored
// device. Mounted at /api/discovery.
function createDiscoveryRouter({ discoveredDevicesRepo, agentsRepo = null, discoverySweepJob = null, agentCommander = null, auditLogger = null, auditLogRepo = null, config = null, getConfig = null, setConfig = null }) {
  const router = express.Router();
  router.use(requireAuth, requireRole(ROLES.ADMIN));

  const STATUSES = ['discovered', 'promoted', 'ignored'];
  // How many agents one fan-out may sweep from. A sweep is rate-limited network
  // scanning; asking a hundred hosts to start at once is a burst that looks like
  // exactly what it is. The cap refuses rather than silently truncating.
  const MAX_FANOUT = 50;
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
  //
  // THE AUDIT LOG IS THE SWEEP HISTORY. There is no sweeps table, because a
  // sweep is an ADMIN ACTION first and a measurement second, and the
  // hash-chained log is what makes it non-repudiable. The cost is that the
  // numbers come back as the `detail` STRING its two writers produced:
  //
  //   server-run  addresses=N probed=N found=N start=<iso> end=<iso>
  //   agent-run   agent-executed addresses=N probed=N found=N scope=<cidrs>
  //
  // So reading them back means parsing that string. It happens HERE, once,
  // rather than in the browser — the format is this repo's own, and a view
  // that parsed it would be a second place to fix when a writer changes.
  // `detail` is still returned untouched beside the parsed fields, so nothing
  // that reads the raw line breaks.
  const KV = /([a-z][a-z-]*)=(\S+)/gi;
  const parseDetail = (detail) => {
    const out = {};
    if (!detail) return out;
    KV.lastIndex = 0; // the regex is reused, and /g carries lastIndex between calls
    let m = KV.exec(detail);
    while (m) { out[m[1].toLowerCase()] = m[2]; m = KV.exec(detail); }
    return out;
  };
  const iso = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };

  router.get('/sweeps', asyncHandler(async (req, res) => {
    const limRaw = req.query.limit;
    const limit = limRaw === undefined || limRaw === '' ? 50 : Number(limRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return res.status(400).json({ error: 'limit must be 1..500' });
    if (!auditLogRepo || typeof auditLogRepo.list !== 'function') return res.json({ sweeps: [] });
    const rows = (await auditLogRepo.list({ category: 'discovery', limit }))
      .filter((r) => r.action === 'discovery_sweep' || r.action === 'discovery_sweep_refused');

    // Who ran it. An agent-run sweep targets `agent:<id>`; a server-run one puts
    // the scope there instead, because the server is the actor. Resolved to a
    // HOSTNAME here — "agent:31" on a screen is a number somebody then has to go
    // and look up, which is the whole reason the name exists.
    const agentIds = [...new Set(rows
      .map((r) => /^agent:(\d+)$/.exec(String(r.target || '')))
      .filter(Boolean)
      .map((m) => Number(m[1])))];
    const hostnames = new Map();
    if (agentsRepo && typeof agentsRepo.findById === 'function') {
      await Promise.all(agentIds.map(async (id) => {
        try {
          const a = await agentsRepo.findById(id);
          // NULL, not the id as a string: an agent that has been deleted since
          // the sweep is a real case, and the UI says so rather than inventing
          // a name for a row that no longer has one.
          if (a && a.hostname) hostnames.set(id, a.hostname);
        } catch { /* a name is a nicety; the sweep still gets listed */ }
      }));
    }

    const sweeps = rows.map((r) => {
      const detail = r.detail ?? null;
      const kv = parseDetail(detail);
      const agentMatch = /^agent:(\d+)$/.exec(String(r.target || ''));
      const agentId = agentMatch ? Number(agentMatch[1]) : null;
      const startedAt = iso(kv.start);
      const endedAt = iso(kv.end);
      return {
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        action: r.action,
        target: r.target ?? null,
        detail,
        refused: r.action === 'discovery_sweep_refused',
        ranBy: agentId
          ? { kind: 'agent', agentId, hostname: hostnames.get(agentId) || null }
          : { kind: 'server', agentId: null, hostname: null },
        // The scope lives in `target` for a server sweep and in `scope=` for an
        // agent one, because each writer put it where it had room.
        scope: kv.scope || (agentId ? null : (r.target || null)),
        // intOrNull, not Number(): `found=0` is a MEASUREMENT (a clean network)
        // and a missing count is not, so they must not both read as zero.
        addresses: intOrNull(kv.addresses),
        probed: intOrNull(kv.probed),
        found: intOrNull(kv.found),
        startedAt,
        endedAt,
        durationMs: startedAt && endedAt
          ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
          : null,
        reason: kv.reason || null,
      };
    });
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

  // Run a sweep now. With `agentId`, push a run-discovery command to that agent
  // so it sweeps from ITS network vantage (empty scope ⇒ the agent's own subnet);
  // candidates come back asynchronously to POST /agents/discovery-results. Without
  // `agentId`, run the server-side sweep inline (as scheduled). 404 unknown agent,
  // 409 agent offline, 503 when neither path is available.
  router.post('/scan', asyncHandler(async (req, res) => {
    // SEVERAL AGENTS AT ONCE. A sweep only reaches the segments the machine
    // running it is on, so "scan the network" on a routed site means one sweep
    // per agent. Doing that one dropdown at a time is how a segment gets
    // forgotten.
    //
    // `agentIds` is additive: `agentId` (single) keeps its exact request and
    // response shape, because scripts and the previous UI use it.
    const rawList = req.body && req.body.agentIds;
    if (Array.isArray(rawList)) {
      if (!rawList.length) return res.status(400).json({ error: 'agentIds must not be empty' });
      if (rawList.length > MAX_FANOUT) return res.status(400).json({ error: `agentIds must hold at most ${MAX_FANOUT} agents` });
      const ids = [];
      for (const raw of rawList) {
        const id = parseId(raw);
        if (id === null) return res.status(400).json({ error: 'Invalid agentId' });
        if (!ids.includes(id)) ids.push(id); // asking twice is one sweep, not two
      }
      if (!agentCommander || typeof agentCommander.sendCommand !== 'function') {
        return res.status(503).json({ error: 'Agent command channel not available' });
      }
      const cfg = await effectiveConfig();
      const discovery = {
        cidrs: Array.isArray(cfg.cidrs) ? cfg.cidrs : [],
        ports: Array.isArray(cfg.ports) ? cfg.ports : [],
        rateLimit: cfg.rateLimit ?? 50,
        addressCap: cfg.addressCap ?? 65536,
      };

      const results = [];
      for (const agentId of ids) {
        // eslint-disable-next-line no-await-in-loop
        const agent = agentsRepo && typeof agentsRepo.findById === 'function' ? await agentsRepo.findById(agentId) : null;
        if (agentsRepo && typeof agentsRepo.findById === 'function' && !agent) {
          results.push({ agentId, hostname: null, delivered: false, reason: 'not_found' });
          continue;
        }
        const hostname = agent ? (agent.display_name || agent.hostname || null) : null;
        const delivered = agentCommander.sendCommand(agentId, { name: 'run-discovery', discovery });
        results.push({ agentId, hostname, delivered: !!delivered, reason: delivered ? null : 'not_connected' });
      }

      const deliveredTo = results.filter((r) => r.delivered);
      if (auditLogger && typeof auditLogger.record === 'function' && deliveredTo.length) {
        await auditLogger.record(req, {
          category: 'discovery',
          action: 'discovery_scan_requested',
          target: deliveredTo.length === 1 ? `agent:${deliveredTo[0].agentId}` : `agents:${deliveredTo.map((r) => r.agentId).join(',')}`,
          detail: `fanout=${deliveredTo.length}/${ids.length} scope=${discovery.cidrs.join(',') || '(self)'}`,
        });
      }
      // PARTIAL SUCCESS IS A SUCCESS. One agent going offline between the page
      // loading and the button being pressed must not cancel the sweeps on the
      // other eleven — the caller gets 202 and a per-agent verdict, and only an
      // empty delivery is a 409.
      if (!deliveredTo.length) {
        return res.status(409).json({ error: 'No agent accepted the sweep', delivered: 0, requested: ids.length, mode: 'agent', results });
      }
      return res.status(202).json({
        ok: true, mode: 'agent', requested: ids.length, delivered: deliveredTo.length, results,
      });
    }

    const rawAgent = req.body && req.body.agentId;
    if (rawAgent !== undefined && rawAgent !== null && rawAgent !== '') {
      const agentId = parseId(rawAgent);
      if (agentId === null) return res.status(400).json({ error: 'Invalid agentId' });
      if (!agentCommander || typeof agentCommander.sendCommand !== 'function') {
        return res.status(503).json({ error: 'Agent command channel not available' });
      }
      if (agentsRepo && typeof agentsRepo.findById === 'function' && !(await agentsRepo.findById(agentId))) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      const cfg = await effectiveConfig();
      const discovery = {
        cidrs: Array.isArray(cfg.cidrs) ? cfg.cidrs : [],
        ports: Array.isArray(cfg.ports) ? cfg.ports : [],
        rateLimit: cfg.rateLimit ?? 50,
        addressCap: cfg.addressCap ?? 65536,
      };
      const delivered = agentCommander.sendCommand(agentId, { name: 'run-discovery', discovery });
      if (!delivered) return res.status(409).json({ error: 'Agent not connected', delivered: 0 });
      if (auditLogger && typeof auditLogger.record === 'function') {
        await auditLogger.record(req, { category: 'discovery', action: 'discovery_scan_requested', target: `agent:${agentId}`, detail: `scope=${discovery.cidrs.join(',') || '(self)'}` });
      }
      return res.status(202).json({ ok: true, agentId, delivered, mode: 'agent' });
    }
    if (!discoverySweepJob || typeof discoverySweepJob.run !== 'function') {
      return res.status(503).json({ error: 'Discovery job not available' });
    }
    const result = await discoverySweepJob.run();
    res.json({ ok: true, mode: 'server', ...(result || {}) });
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
