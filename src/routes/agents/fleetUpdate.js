'use strict';

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../../auth/middleware');
const { ROLES } = require('../../auth/roles');

// Updating a FLEET, rather than an agent.
//
// POST /agents/:id/update is one agent, one click, and only while that agent
// happens to be connected. On two hundred hosts that is two hundred clicks that
// each have to coincide with a connection — which is why, in practice, fleets do
// not get updated. This route is the same push, selected and paced:
//
//   * it selects the agents actually BEHIND the offered version, so a re-run is
//     safe and converges (an agent that already updated drops out of the set);
//   * it moves at most `batch` agents per call, so a bad release costs a batch.
//     One call with batch=1 is the canary; the operator looks, then continues;
//   * an agent that is not connected has its update QUEUED rather than counted as
//     a failure — that is the case the queue exists for;
//   * every agent gets its own audit row, because "the fleet was updated" is not
//     a thing anyone can act on six weeks later.
//
// GET /agents/updates/fleet answers what a rollout WOULD do, with no side
// effects, so the dashboard can show the number before anyone commits to it.
function createFleetUpdateRouter(ctx) {
  const router = express.Router();
  const {
    agentsRepo, agentCommander, updateService, settingsService, logger,
    signCommand, recordRequested, markFailed,
  } = ctx;

  // The agents this rollout would touch: behind the offered version, optionally
  // narrowed to a site or an explicit list. Ordered by id so two calls walk the
  // fleet in the same order and the set shrinks from the front.
  async function selectTargets({ agentIds = null, locationId = null }) {
    const offered = updateService.offeredVersion();
    const all = await agentsRepo.findAll();
    const wanted = agentIds && agentIds.length ? new Set(agentIds.map(Number)) : null;
    const targets = [];
    let unknownVersion = 0;
    for (const agent of all) {
      if (wanted && !wanted.has(Number(agent.id))) continue;
      if (locationId != null && Number(agent.location_id) !== Number(locationId)) continue;
      const caps = agent.capabilities || {};
      const version = caps.agentVersion || null;
      // An agent that has never reported a version is never pushed code on a
      // guess. It shows in the summary so it is visible rather than silently
      // excluded.
      if (!version) { unknownVersion += 1; continue; }
      // Docker rebuilds its image and nothing restarts an unmanaged process, so
      // pushing to either produces a decline and a confusing audit row.
      const managed = String(caps.managed || '').toLowerCase();
      if (managed === 'docker' || managed === 'unmanaged') continue;
      if (!updateService.isBehind(version)) continue;
      targets.push({ id: Number(agent.id), hostname: agent.hostname || null, version, managed, agent });
    }
    targets.sort((a, b) => a.id - b.id);
    return { offered, targets, unknownVersion, total: all.length };
  }

  function parseIdList(value) {
    if (!Array.isArray(value)) return null;
    const out = [];
    for (const v of value) {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) return undefined; // signals invalid
      out.push(n);
    }
    return out;
  }

  // GET /agents/updates/fleet — what a rollout would do. Read-only, viewer+.
  router.get(
    '/updates/fleet',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const { offered, targets, unknownVersion, total } = await selectTargets({});
      const policy = settingsService && typeof settingsService.getAgents === 'function'
        ? await settingsService.getAgents()
        : { autoUpdate: false, autoUpdateWindow: '', autoUpdateBatch: 10 };
      res.json({
        offeredVersion: offered || null,
        agents: total,
        behind: targets.length,
        unknownVersion,
        batch: policy.autoUpdateBatch,
        autoUpdate: !!policy.autoUpdate,
        autoUpdateWindow: policy.autoUpdateWindow || '',
        targets: targets.map((t) => ({ id: t.id, hostname: t.hostname, version: t.version, managed: t.managed })),
      });
    })
  );

  // POST /agents/updates/fleet — move one batch. admin only.
  router.post(
    '/updates/fleet',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const body = (req && req.body) || {};
      const ids = parseIdList(body.agentIds);
      if (ids === undefined) {
        return res.status(400).json({ error: 'Validation failed', details: { agentIds: 'agentIds must be positive integers' } });
      }
      let locationId = null;
      if (body.locationId != null) {
        const n = Number(body.locationId);
        if (!Number.isInteger(n) || n <= 0) {
          return res.status(400).json({ error: 'Validation failed', details: { locationId: 'locationId must be a positive integer' } });
        }
        locationId = n;
      }
      const policy = settingsService && typeof settingsService.getAgents === 'function'
        ? await settingsService.getAgents()
        : { autoUpdateBatch: 10 };
      let batch = policy.autoUpdateBatch || 10;
      if (body.batch != null) {
        const n = Number(body.batch);
        if (!Number.isInteger(n) || n < 1 || n > 500) {
          return res.status(400).json({ error: 'Validation failed', details: { batch: 'batch must be an integer between 1 and 500' } });
        }
        batch = n;
      }
      const queueOffline = body.queueOffline === undefined ? true : !!body.queueOffline;

      const { offered, targets, unknownVersion } = await selectTargets({ agentIds: ids, locationId });
      if (!offered) return res.status(503).json({ error: 'No agent version is published on the server' });

      // A dry run answers the same question the GET does, but against the
      // narrowing this call asked for — so "what would --location 3 do" needs no
      // second endpoint.
      if (body.dryRun) {
        return res.json({
          dryRun: true,
          offeredVersion: offered,
          behind: targets.length,
          unknownVersion,
          batch,
          wouldUpdate: targets.slice(0, batch).map((t) => ({ id: t.id, hostname: t.hostname, version: t.version })),
        });
      }
      if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
        return res.status(503).json({ error: 'Agent channel not available' });
      }

      const payload = await updateService.resolvePayload({ log: req.log || logger });
      if (!payload.ok) return res.status(503).json({ error: 'No agent source is published on the server' });

      const slice = targets.slice(0, batch);
      const results = [];
      for (const target of slice) {
        const command = { ...payload.command };
        const auditId = await recordRequested('upgrade', target.agent, req, payload.targetVersion);
        if (auditId) command.auditId = auditId;
        const out = await agentCommander.sendCommandAndWait(target.id, signCommand(target.id, command), { timeoutMs: 8000 });
        if (out.delivered === 0) {
          if (!queueOffline) {
            await markFailed(auditId, 'agent not connected');
            results.push({ id: target.id, hostname: target.hostname, outcome: 'offline' });
            continue;
          }
          const queued = await updateService.queue(target.id, command, { auditId });
          if (!queued.queued) await markFailed(auditId, 'agent not connected');
          results.push({ id: target.id, hostname: target.hostname, outcome: queued.queued ? 'queued' : 'offline' });
          continue;
        }
        const reply = out.reply || {};
        if (reply.accepted === false) {
          await markFailed(auditId, reply.reason || 'declined');
          results.push({ id: target.id, hostname: target.hostname, outcome: 'declined', reason: reply.reason || null });
          continue;
        }
        results.push({
          id: target.id,
          hostname: target.hostname,
          outcome: out.acked ? 'accepted' : 'sent',
          runtime: reply.runtime || null,
        });
      }

      const counts = results.reduce((acc, r) => { acc[r.outcome] = (acc[r.outcome] || 0) + 1; return acc; }, {});
      (req.log || logger).info(
        `agents: fleet update to v${payload.targetVersion} moved ${results.length} agent(s) `
        + `(${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}); ${Math.max(0, targets.length - slice.length)} still behind.`
      );

      res.status(202).json({
        offeredVersion: offered,
        targetVersion: payload.targetVersion,
        signed: payload.signed,
        signedReason: payload.signedReason,
        batch,
        moved: results.length,
        remaining: Math.max(0, targets.length - slice.length),
        unknownVersion,
        counts,
        results,
      });
    })
  );

  return router;
}

module.exports = { createFleetUpdateRouter };
