'use strict';

const crypto = require('crypto');
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateAgentManagedInput, MAX_INTERVAL_MS } = require('../validation/agentValidation');
const { validateTimeRange } = require('../validation/resultsValidation');
const { validateProbeSpec } = require('../validation/probeValidation');
const { parseId } = require('../validation/locationValidation');
const { verifyProof } = require('../license/verify');
const { INSTALLABLE_TOOLS, isAllowedTool } = require('../agentTools');
const { silentLogger } = require('../logger');

// Aggregates the byPort / byProtocol / topTalkers entries across a set of
// NetFlow measurements, optionally filtered to one port and/or protocol.
// `series` is the matched bytes per measurement (oldest first) and is only
// populated when a port or protocol filter is active. Pure; exported for tests.
function aggregateFlows(rows, { port = null, protocol = null } = {}) {
  const byPort = new Map();
  const byProtocol = new Map();
  const byTalker = new Map();
  const series = [];

  const bump = (map, key, e) => {
    const cur = map.get(key) || { bytes: 0, packets: 0, flows: 0 };
    cur.bytes += Number(e.bytes) || 0;
    cur.packets += Number(e.packets) || 0;
    cur.flows += Number(e.flows) || 0;
    map.set(key, cur);
  };

  for (const row of rows) {
    const t = row.payload && row.payload.traffic;
    if (!t || (!t.byPort && !t.byProtocol && !t.topTalkers)) continue;
    let matchBytes = 0;
    for (const e of t.byPort || []) {
      if (port !== null && e.port !== port) continue;
      bump(byPort, e.port, e);
      if (port !== null) matchBytes += Number(e.bytes) || 0;
    }
    for (const e of t.byProtocol || []) {
      if (protocol && String(e.protocol).toLowerCase() !== protocol) continue;
      bump(byProtocol, e.protocol, e);
      if (protocol && port === null) matchBytes += Number(e.bytes) || 0;
    }
    for (const e of t.topTalkers || []) bump(byTalker, e.pair, e);
    const at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    if (port !== null || protocol) series.push({ at, bytes: matchBytes });
  }

  const sortMap = (map, key) =>
    Array.from(map.entries())
      .map(([k, v]) => ({ [key]: k, ...v }))
      .sort((a, b) => b.bytes - a.bytes);

  return {
    byPort: sortMap(byPort, 'port'),
    byProtocol: sortMap(byProtocol, 'protocol'),
    topTalkers: sortMap(byTalker, 'pair').slice(0, 50),
    series: series.reverse(), // oldest first
  };
}

// Agents router with role-based access control:
//   - viewer+        may read         (GET)
//   - operator/admin may edit metadata (PUT — server-managed fields only)
//   - admin          may delete       (DELETE)
//
// Agents are created via enrollment (prompt 4) — there is intentionally no
// manual POST /agents here.
function createAgentsRouter({ agentsRepo, locationsRepo, resultsRepo, agentCommander, agentSourceStore, releaseStore = null, releasePublicKey = '', auditRepo = null, integrationTrigger = null, logger = silentLogger }) {
  const router = express.Router();

  // Response helpers for the error shapes repeated across this router.
  const invalidId = (res) => res.status(400).json({ error: 'Invalid id' });
  const notFound = (res) => res.status(404).json({ error: 'Agent not found' });
  const validationError = (res, details) => res.status(400).json({ error: 'Validation failed', details });

  // Audit helpers for server-initiated actions (upgrade/delete). Best-effort:
  // auditing must never fail or block the action it records. record() returns the
  // new row id (so the command can carry it for the agent to echo on completion);
  // markFailed() flips it terminal when we already know it won't proceed.
  async function recordRequested(action, agent, req, targetVersion = null) {
    if (!auditRepo || typeof auditRepo.record !== 'function') return null;
    try {
      return await auditRepo.record({
        agentId: agent.id,
        agentHostname: agent.hostname || null,
        locationId: agent.location_id ?? null,
        actorUserId: (req.user && req.user.id) || null,
        actorEmail: (req.user && req.user.email) || null,
        actorRole: (req.user && req.user.role) || null,
        action,
        targetVersion,
      });
    } catch (err) {
      // Best-effort audit: never block the action. But the FAILURE of an audit
      // write belongs in the operational log (we can't audit the audit system),
      // so it isn't lost silently. See docs/audit-vs-logging.md.
      (req.log || logger).warn(`agents: audit record(${action}) for agent ${agent && agent.id} failed (${err.message})`);
      return null;
    }
  }
  async function markFailed(auditId, resultDetail) {
    if (!auditId || !auditRepo || typeof auditRepo.complete !== 'function') return;
    try { await auditRepo.complete(auditId, { state: 'failed', resultDetail }); } catch (err) { logger.warn(`agents: audit complete(failed) for auditId ${auditId} failed (${err.message})`); }
  }

  // POST /agents/releases — upload a SIGNED agent release tarball (admin). The
  // server VERIFIES the Ed25519 signature over the release manifest AND that the
  // tarball's sha256 matches that (signed) manifest BEFORE storing it — so only
  // authentic, untampered builds ever become available to push to agents. The
  // tarball is the raw request body (application/octet-stream, so it bypasses the
  // 1 MB JSON limit); the manifest + signature + version ride in headers:
  //   X-Release-Version    e.g. 0.3.0
  //   X-Release-Manifest   base64(JSON) of { version, sha256, size, ... } — the SIGNED bytes
  //   X-Release-Signature  base64 Ed25519 signature over the canonical manifest
  router.post(
    '/releases',
    requireAuth,
    requireRole(ROLES.ADMIN),
    express.raw({ type: 'application/octet-stream', limit: '64mb' }),
    asyncHandler(async (req, res) => {
      if (!releaseStore || typeof releaseStore.add !== 'function') {
        return res.status(503).json({ error: 'Release store not available' });
      }
      // releasePublicKey may be a live resolver (managed key, changeable at runtime)
      // or a plain string (tests / env key).
      const releaseKey = (typeof releasePublicKey === 'function' ? releasePublicKey() : releasePublicKey) || '';
      if (!releaseKey) {
        return res.status(503).json({ error: 'Agent release public key not configured' });
      }
      const tarball = Buffer.isBuffer(req.body) ? req.body : null;
      if (!tarball || tarball.length === 0) {
        return res.status(400).json({ error: 'Empty body — POST the gzipped tarball as application/octet-stream' });
      }
      const version = String(req.get('X-Release-Version') || '').trim();
      const signature = String(req.get('X-Release-Signature') || '').trim();
      let manifest = null;
      try {
        manifest = JSON.parse(Buffer.from(String(req.get('X-Release-Manifest') || ''), 'base64').toString('utf8'));
      } catch {
        manifest = null;
      }
      if (!version || !signature || !manifest || typeof manifest !== 'object') {
        return res.status(400).json({ error: 'Missing or invalid X-Release-Version / X-Release-Signature / X-Release-Manifest' });
      }
      if (manifest.version !== version) {
        return res.status(400).json({ error: 'Manifest version does not match X-Release-Version' });
      }
      // 1) Authenticity: Ed25519 signature over the canonical manifest (reuses the
      //    exact license-proof verifier — a different, release-only public key).
      if (!verifyProof(manifest, signature, releaseKey)) {
        return res.status(422).json({ error: 'Release signature did not verify' });
      }
      // 2) Integrity: the uploaded bytes must match the sha256 the signed manifest binds.
      const sha256 = crypto.createHash('sha256').update(tarball).digest('hex');
      if (manifest.sha256 !== sha256) {
        return res.status(422).json({ error: 'Tarball sha256 does not match the signed manifest' });
      }
      if (Number.isInteger(manifest.size) && manifest.size !== tarball.length) {
        return res.status(422).json({ error: 'Tarball size does not match the signed manifest' });
      }
      const uploadedBy = (req.user && (req.user.id || req.user.sub)) || null;
      const meta = releaseStore.add({ version, buffer: tarball, sha256, size: tarball.length, signature, manifest, uploadedBy });
      res.status(201).json({ version: meta.version, sha256: meta.sha256, size: meta.size, createdAt: meta.createdAt });
    })
  );

  // POST /agents/:id/ping — liveness check: asks the connected agent to reply
  // over the WebSocket and reports the round-trip time + the agent's live
  // version/sources. viewer+ (no side effects). 409 if the agent isn't connected.
  router.post(
    '/:id/ping',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      const startedAt = Date.now();
      const out = await agentCommander.sendCommandAndWait(id, { name: 'ping' }, { timeoutMs: 5000 });
      if (out.delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', connected: false });
      }
      const reply = out.reply || {};
      res.json({
        connected: true,
        acked: !!out.acked,
        timedOut: !!out.timedOut,
        latencyMs: Date.now() - startedAt,
        agentVersion: reply.agentVersion || null,
        sources: Array.isArray(reply.sources) ? reply.sources : null,
        managed: reply.managed || null,
      });
    })
  );

  // POST /agents/:id/diagnose — ask the connected agent to introspect its flow
  // pipeline (monitor source, collector receive/decode counters, local exporter
  // state, last report) and report a snapshot, so an operator can see exactly
  // where flows stop. Read-only on the agent — viewer+. 409 if not connected,
  // 504 if it doesn't reply in time, 503 if the agent channel is unavailable.
  router.post(
    '/:id/diagnose',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      const out = await agentCommander.sendCommandAndWait(id, { name: 'diagnose' }, { timeoutMs: 5000 });
      if (out.delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', connected: false });
      }
      if (out.timedOut || !out.reply) {
        return res.status(504).json({ error: 'Agent did not reply', connected: true, timedOut: true });
      }
      res.json({ connected: true, diagnostic: out.reply.diagnostic || null });
    })
  );

  // POST /agents/:id/update — ask a connected, systemd-managed agent to rebuild
  // and restart onto the new code. admin only. A signed release (uploaded via
  // POST /agents/releases) is pushed in preference to the startup-packaged source
  // bundle: the command then carries the release version + sha256 + Ed25519
  // signature, which the agent verifies before extracting. Falls back to the
  // source bundle (sha256 only) when no signed release exists, so existing
  // deployments keep working. Docker/unmanaged agents decline (host rebuilds).
  router.post(
    '/:id/update',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);

      const release = releaseStore && typeof releaseStore.latest === 'function' ? releaseStore.latest() : null;
      const haveSource = agentSourceStore && typeof agentSourceStore.available === 'function' && agentSourceStore.available();
      if (!release && !haveSource) {
        return res.status(503).json({ error: 'No agent source is published on the server' });
      }
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      const command = release
        ? { name: 'update', version: release.version, sha256: release.sha256, signature: release.signature }
        : { name: 'update', sha256: agentSourceStore.sha256, version: (typeof agentSourceStore.sourceVersion === 'function' ? agentSourceStore.sourceVersion() : null) };
      const targetVersion = command.version;
      // Audit 'requested' first so the command can carry the audit id; the agent
      // echoes it back on completion (handled where the agent reports its result).
      const auditId = await recordRequested('upgrade', agent, req, targetVersion);
      if (auditId) command.auditId = auditId;
      const out = await agentCommander.sendCommandAndWait(id, command, { timeoutMs: 8000 });
      if (out.delivered === 0) {
        await markFailed(auditId, 'agent not connected');
        return res.status(409).json({ error: 'Agent not connected', connected: false });
      }
      const reply = out.reply || {};
      // A runtime that declines (docker/unmanaged) is a terminal outcome we know now.
      if (reply.accepted === false) await markFailed(auditId, reply.reason || 'declined');
      res.status(202).json({
        connected: true,
        acked: !!out.acked,
        accepted: !!reply.accepted,
        runtime: reply.runtime || null,
        reason: reply.reason || null,
        targetVersion,
        signed: !!release,
        auditId: auditId || null,
      });
    })
  );

  // POST /agents/:id/delete — ask a connected agent to STOP its service, remove
  // its own files and securely wipe its token, then report back. admin only. The
  // action is audited (requested -> completed/failed). The server agent row is
  // removed only once the agent CONFIRMS the self-delete (handled where the agent
  // reports its result), so a declined/failed delete never orphans a live agent.
  // To force-remove the server-side record regardless, use DELETE /agents/:id.
  router.post(
    '/:id/delete',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      const auditId = await recordRequested('delete', agent, req, null);
      const command = { name: 'delete' };
      if (auditId) command.auditId = auditId;
      const out = await agentCommander.sendCommandAndWait(id, command, { timeoutMs: 8000 });
      if (out.delivered === 0) {
        await markFailed(auditId, 'agent not connected');
        return res.status(409).json({ error: 'Agent not connected', connected: false });
      }
      const reply = out.reply || {};
      if (reply.accepted === false) await markFailed(auditId, reply.reason || 'declined');
      res.status(202).json({
        connected: true,
        acked: !!out.acked,
        accepted: !!reply.accepted,
        reason: reply.reason || null,
        auditId: auditId || null,
      });
    })
  );

  // POST /agents/:id/install-tool { tool } — ask a connected agent to install a
  // missing diagnostic tool (e.g. traceroute) from its package manager, then
  // report back. operator/admin. The tool must be on the shared allowlist; the
  // agent independently enforces its OWN allowlist (so the server can never push
  // an arbitrary package). Audited (requested -> completed/failed) like
  // upgrade/delete, with the agent echoing the audit id back on completion.
  router.post(
    '/:id/install-tool',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const tool = String((req.body && req.body.tool) || '').trim().toLowerCase();
      if (!isAllowedTool(tool)) {
        return validationError(res, { tool: `tool must be one of ${INSTALLABLE_TOOLS.join(', ')}` });
      }
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }
      const auditId = await recordRequested('install-tool', agent, req, tool);
      const command = { name: 'install-tool', tool };
      if (auditId) command.auditId = auditId;
      const out = await agentCommander.sendCommandAndWait(id, command, { timeoutMs: 8000 });
      if (out.delivered === 0) {
        await markFailed(auditId, 'agent not connected');
        return res.status(409).json({ error: 'Agent not connected', connected: false });
      }
      const reply = out.reply || {};
      if (reply.accepted === false) await markFailed(auditId, reply.reason || 'declined');
      res.status(202).json({
        connected: true,
        acked: !!out.acked,
        accepted: !!reply.accepted,
        reason: reply.reason || null,
        tool,
        auditId: auditId || null,
      });
    })
  );

  // POST /agents/:id/run-test — push a "run test" command to a connected agent
  // over the live WebSocket. operator/admin. Returns 202 with how many
  // connections received it, 409 if the agent isn't currently connected.
  router.post(
    '/:id/run-test',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const command = { name: 'run-test' };
      // Optional repeat interval; ignore values outside (0, 1 day] rather than
      // forwarding an unbounded number across the server -> agent boundary.
      if (Number.isInteger(body.intervalMs) && body.intervalMs > 0 && body.intervalMs <= MAX_INTERVAL_MS) {
        command.intervalMs = body.intervalMs;
      }

      const delivered = agentCommander ? agentCommander.sendCommand(id, command) : 0;
      if (delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', delivered: 0 });
      }
      res.status(202).json({ delivered, agentId: id });
    })
  );

  // POST /agents/:id/probe — push an active probe (ping/tcp/dns/traceroute) to a
  // connected agent. operator/admin. The agent runs it and reports back via
  // POST /agents/probe-results. 409 if the agent isn't connected.
  router.post(
    '/:id/probe',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const { value: probe, errors } = validateProbeSpec(req.body);
      if (errors) return validationError(res, errors);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      const delivered = agentCommander ? agentCommander.sendCommand(id, { name: 'run-probe', probe }) : 0;
      if (delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', delivered: 0 });
      }
      res.status(202).json({ delivered, agentId: id, probe });
    })
  );

  // POST /agents/:id/run-speedtest — push an active speed test to a connected
  // agent. operator/admin. The agent measures download/upload Mbps against the
  // server and reports via POST /speedtest/results. 409 if not connected.
  router.post(
    '/:id/run-speedtest',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const command = { name: 'speedtest' };
      if (Number.isInteger(body.bytes) && body.bytes > 0) command.bytes = body.bytes;
      const delivered = agentCommander ? agentCommander.sendCommand(id, command) : 0;
      if (delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', delivered: 0 });
      }
      res.status(202).json({ delivered, agentId: id });
    })
  );

  // GET /agents — list, with the joined location name. Each agent carries the
  // latest hsflowd exporter status it reported (or null), for the dashboard.
  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const agents = await agentsRepo.findAll();
      const getStatus = agentCommander && typeof agentCommander.getSflowStatus === 'function'
        ? agentCommander.getSflowStatus
        : () => null;
      // Only attach hsflowd when the agent has actually reported a status, so
      // the response shape is unchanged for the common (non-sflow) case.
      res.json(agents.map((a) => {
        const hs = getStatus(a.id);
        return hs ? { ...a, hsflowd: hs } : a;
      }));
    })
  );

  // GET /agents/:id
  router.get(
    '/:id',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      res.json(agent);
    })
  );

  // GET /agents/:id/audit — the upgrade/delete action trail for one agent
  // (requested -> completed/failed), newest first. admin only.
  router.get(
    '/:id/audit',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      if (!auditRepo || typeof auditRepo.findByAgent !== 'function') {
        return res.status(503).json({ error: 'Audit log not available' });
      }
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      res.json(await auditRepo.findByAgent(id, { limit: 100 }));
    })
  );

  // GET /agents/:id/results — results reported by the agent. viewer+ (user RBAC).
  // Optional time range: ?from=&to=&limit= (ISO dates; newest first).
  router.get(
    '/:id/results',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const { value: range, errors } = validateTimeRange(req.query);
      if (errors) return validationError(res, errors);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      res.json(await resultsRepo.findByAgentId(id, range));
    })
  );

  // GET /agents/:id/flows?port=&protocol=&from=&to= — search NetFlow data the
  // agent reported (only present when its source is 'netflow'). Aggregates the
  // byPort / byProtocol entries across the matching measurements in the range,
  // optionally filtered by a specific port and/or protocol. viewer+.
  router.get(
    '/:id/flows',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const { value: range, errors } = validateTimeRange(req.query);
      if (errors) return validationError(res, errors);
      // Optional filters.
      let port = null;
      if (req.query.port !== undefined && req.query.port !== '') {
        if (!/^\d+$/.test(String(req.query.port))) {
          return validationError(res, { port: 'port must be an integer' });
        }
        port = Number(req.query.port);
      }
      const protocol = req.query.protocol ? String(req.query.protocol).toLowerCase() : null;

      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);

      const rows = await resultsRepo.findByAgentId(id, range);
      res.json({
        agentId: id,
        filter: { port, protocol },
        from: range.from ? range.from.toISOString() : null,
        to: range.to ? range.to.toISOString() : null,
        measurements: rows.length,
        ...aggregateFlows(rows, { port, protocol }),
      });
    })
  );

  // PUT /agents/:id — updates ONLY the server-managed fields
  // (display_name, location_id, notes, meta). operator or admin.
  router.put(
    '/:id',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);

      const { value, errors } = validateAgentManagedInput(req.body);
      if (errors) return validationError(res, errors);

      const existing = await agentsRepo.findById(id);
      if (!existing) return notFound(res);

      // Reject a location_id that doesn't reference an existing location, so
      // the client gets a 400 rather than a foreign-key 500.
      if (value.location_id !== null && !(await locationsRepo.findById(value.location_id))) {
        return validationError(res, { location_id: 'location_id does not reference an existing location' });
      }

      const updated = await agentsRepo.updateManaged(id, value);
      res.json(updated);
    })
  );

  // DELETE /agents/:id — admin only.
  router.delete(
    '/:id',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      // Snapshot the agent before removal so the integration event carries its
      // hostname/location (for IPAM device removal when allowDelete is set).
      const agent = await agentsRepo.findById(id);
      const removed = await agentsRepo.remove(id);
      if (!removed) return notFound(res);
      // Outbound integrations: notify IPAM the agent is gone. Fire-and-forget; an
      // integration NEVER blocks or fails the delete (deletion is one-way and
      // gated by the connector's own allow-delete flag).
      if (agent && integrationTrigger && typeof integrationTrigger.emitAgentEvent === 'function') {
        try { integrationTrigger.emitAgentEvent('delete', agent).catch(() => {}); } catch { /* best-effort */ }
      }
      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createAgentsRouter, aggregateFlows };
