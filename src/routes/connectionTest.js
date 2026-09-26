'use strict';

// Connection Test — one address, the whole battery of checks.
//
// The Run-a-probe tab asks one question at a time. This asks all of them at
// once: give it an IP or a DNS name and it pushes every selected check from
// src/connectionTest/checks.js to one agent. Nothing new is stored — each check
// is an ordinary probe, so the results land in probe_results and appear on the
// same screens (latest results, path visualisation, fleet health, availability)
// as any other probe.
//
//   GET  /api/connection-test/checks   viewer+   the catalogue (per target)
//   POST /api/connection-test/run      operator+ dispatch the selection now
//   POST /api/connection-test/walk     operator+ describe a problem, run the ladder
//   GET  /api/connection-test/ladder   viewer+   where the communication stops
//   POST /api/connection-test/schedule operator+ save it as a recurring package
//
// Why a router of its own rather than a loop in the browser: the catalogue then
// exists once, on the server. The dashboard renders what /checks serves and a
// run builds its probe specs from the same entries, so a check the screen
// offers is always a check the server can dispatch — and one operator action is
// one audit record, not nine.

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const net = require('net');
const { catalogue, specsFor, CHECK_IDS } = require('../connectionTest/checks');
const ladders = require('../connectionTest/ladders');
const { arpContext } = require('../connectionTest/arpContext');
const { targetHost } = require('../connectionTest/ladders/reachability');
const {
  validateConnectionTestRun,
  validateConnectionTestSchedule,
  validateConnectionTestWalk,
  validateLadderQuery,
} = require('../validation/connectionTestValidation');
const { validateTestPackageInput } = require('../validation/testPackageValidation');

function createConnectionTestRouter({ agentsRepo, agentCommander, probeResultsRepo = null, arpEntriesRepo = null, testPackagesRepo = null, usageService = null, auditLogger = null, settingsService = null, deviceLocator = null, interfaceHealthFor = null }) {
  const router = express.Router();
  const validationError = (res, details) => res.status(400).json({ error: 'Validation failed', details });

  // The ladder's configuration (Settings → Diagnostics). A deployment with no
  // settings service, or a read that fails, walks the shipped default rather
  // than refusing to answer — the ladder is a diagnostic, and one that will not
  // run when the settings table is unreachable is the wrong trade.
  const ladderConfig = async (id) => {
    if (!settingsService || typeof settingsService.getLadder !== 'function') return null;
    try { return await settingsService.getLadder(id); } catch { return null; }
  };

  // An agent's own address, as it reported it. The two-way ladder needs each
  // end to probe the OTHER, and this is the only address the far end is known
  // by that the near end can actually reach.
  const addressOf = (agent) => {
    const ips = agent && agent.capabilities && Array.isArray(agent.capabilities.ips) ? agent.capabilities.ips : [];
    return ips.find((ip) => typeof ip === 'string' && ip) || null;
  };
  const nameOf = (agent) => (agent && (agent.display_name || agent.hostname)) || (agent ? `agent ${agent.id}` : null);

  // The probe rows one agent holds about one target.
  const rowsFor = async (agentId) => (probeResultsRepo ? probeResultsRepo.latestByAgent(agentId, 200) : []);

  // The catalogue. `?host=` is optional: with one, each entry also says whether
  // it APPLIES to that target (a DNS lookup of an IP literal does not), so the
  // screen can grey a row out with a reason instead of running a check that
  // answers nothing.
  router.get(
    '/checks',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const host = typeof req.query.host === 'string' && req.query.host.trim() ? req.query.host.trim() : null;
      res.json({ host, checks: catalogue(host) });
    })
  );

  // Run the selection now, against one agent. 202 with what was dispatched —
  // the agent reports each result back through the normal probe-results path,
  // so the caller polls /api/probes/latest exactly as the probe tab does.
  router.post(
    '/run',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const { value, errors } = validateConnectionTestRun(req.body);
      if (errors) return validationError(res, errors);

      const agent = await agentsRepo.findById(value.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const { specs, skipped } = specsFor(value.host, value.checks);
      if (!specs.length) {
        return res.status(400).json({
          error: 'Validation failed',
          details: { checks: 'none of the selected checks can run against this target' },
          skipped,
        });
      }

      let delivered = 0;
      const dispatched = [];
      for (const s of specs) {
        const n = agentCommander ? agentCommander.sendCommand(value.agentId, { name: 'run-probe', probe: s.probe }) : 0;
        if (n > 0) { delivered += n; dispatched.push({ id: s.id, type: s.probe.type, port: s.probe.port || null }); }
      }
      // Nothing reached the agent: it is not connected. Reported as such rather
      // than as an empty success, so the screen says why nothing is happening.
      if (delivered === 0) return res.status(409).json({ error: 'Agent not connected', delivered: 0 });

      // One operator action, one record in the hash-chained compliance trail —
      // the same treatment a single hand-run probe gets, because this is the
      // same act against a customer network, nine times over. Metadata only.
      if (auditLogger && typeof auditLogger.record === 'function') {
        await auditLogger.record(req, {
          category: 'agent',
          action: 'probe_start',
          target: `agent:${value.agentId}`,
          detail: JSON.stringify({ connectionTest: true, target: value.host, checks: dispatched.map((d) => d.id) }),
        });
      }

      res.status(202).json({ agentId: value.agentId, host: value.host, delivered, dispatched, skipped });
    })
  );

  // What ladders exist, what each needs before it can run, and which of its
  // rungs may be reordered. Served so the screen offers what the server can
  // actually walk, the same rule the check catalogue follows.
  router.get(
    '/ladders',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      res.json({ ladders: ladders.catalogue() });
    })
  );

  // --- the ladder ----------------------------------------------------------
  //
  // "I cannot reach X" as one call. The operator names the destination and, if
  // they want, says what is wrong in their own words; every check in the
  // catalogue that applies is pushed at once, and GET /ladder then reads the
  // results back as one verdict: which rung the communication stops at.
  //
  // The selection is NOT a parameter. The point of the ladder is that the whole
  // of it runs — a rung that was skipped reads `unknown`, and a ladder full of
  // unknowns cannot say where anything stops. An operator who wants to choose
  // has POST /run.
  router.post(
    '/walk',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const { value, errors } = validateConnectionTestWalk(req.body);
      if (errors) return validationError(res, errors);
      const def = ladders.get(value.ladder);

      // A ladder that dispatches nothing has nothing to run: device location
      // reads what the fleet already reported, so asking to "run" it is asking
      // for the verdict, and the caller is told to read it instead of being
      // handed a 202 that means nothing happened.
      if (def.needs.agents === 0) {
        return res.status(400).json({
          error: 'Validation failed',
          details: { ladder: `${def.id} measures nothing new — read it with GET /api/connection-test/ladder` },
        });
      }

      const agent = await agentsRepo.findById(value.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const peer = def.needs.agents >= 2 ? await agentsRepo.findById(value.peerAgentId) : null;
      if (def.needs.agents >= 2 && !peer) return res.status(404).json({ error: 'Peer agent not found' });
      if (peer && Number(peer.id) === Number(agent.id)) {
        return validationError(res, { peerAgentId: 'the two ends of a two-way test must be different agents' });
      }

      const config = await ladderConfig(def.id);
      const cfg = ladders.resolveConfig(def, config);

      // Each ladder says what it pushes. The reachability one defers to the
      // check catalogue (which is also what the screen lists); the others carry
      // their own short list.
      const plans = [];
      if (def.needs.agents < 2) {
        const { specs, skipped } = def.dispatch({ host: value.host || null, config: cfg });
        if (!specs.length) {
          return res.status(400).json({
            error: 'Validation failed',
            details: { host: 'nothing this ladder runs can be asked of this target' },
            skipped,
          });
        }
        plans.push({ agentId: value.agentId, specs, skipped });
      } else {
        // Both ends probe the OTHER end's own address. Without one there is
        // nothing to aim at, and saying so beats dispatching at a name that
        // does not resolve.
        const here = addressOf(agent);
        const there = addressOf(peer);
        if (!there || !here) {
          return validationError(res, {
            peerAgentId: `${!there ? nameOf(peer) : nameOf(agent)} has not reported an address of its own, so the other end has nothing to probe`,
          });
        }
        plans.push({ agentId: value.agentId, ...def.dispatch({ host: there, config: cfg }) });
        plans.push({ agentId: value.peerAgentId, ...def.dispatch({ host: here, config: cfg }) });
      }

      let delivered = 0;
      const dispatched = [];
      for (const plan of plans) {
        for (const sp of plan.specs) {
          const n = agentCommander ? agentCommander.sendCommand(plan.agentId, { name: 'run-probe', probe: sp.probe }) : 0;
          if (n > 0) { delivered += n; dispatched.push({ agentId: plan.agentId, id: sp.id, type: sp.probe.type, port: sp.probe.port || null }); }
        }
      }
      if (delivered === 0) return res.status(409).json({ error: 'Agent not connected', delivered: 0 });

      if (auditLogger && typeof auditLogger.record === 'function') {
        await auditLogger.record(req, {
          category: 'agent',
          action: 'probe_start',
          target: `agent:${value.agentId}`,
          // The symptom rides as a JSON string VALUE, never as part of a
          // sentence — the same rule the diagnose module follows for the
          // operator's own words.
          detail: JSON.stringify({
            ladder: def.id,
            target: value.host || null,
            peerAgentId: value.peerAgentId || null,
            symptom: value.symptom || null,
            checks: dispatched.map((d) => d.id),
          }),
        });
      }

      res.status(202).json({
        ladder: def.id,
        agentId: value.agentId,
        peerAgentId: value.peerAgentId || null,
        host: value.host || null,
        symptom: value.symptom || null,
        delivered,
        dispatched,
        skipped: plans.flatMap((pl) => pl.skipped),
      });
    })
  );

  // Where does it stop? Computed from results already in probe_results, so it
  // can be asked again at any time, answers for a run somebody else started,
  // and can never disagree with the rows a screen is showing.
  router.get(
    '/ladder',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const { value, errors } = validateLadderQuery(req.query);
      if (errors) return validationError(res, errors);
      const def = ladders.get(value.ladder);

      // Each ladder reads a different thing, so each one collects its own
      // context here — the walk itself never touches a repository.
      let ctx;
      if (def.id === ladders.DEVICE_LOCATION) {
        if (!deviceLocator) return res.status(503).json({ error: 'Device location is not available on this server' });
        // `where()` returns null for a device nothing has ever seen. That is a
        // finding, not a 404: the ladder's first rung says so in a sentence,
        // and a 404 would make it look like the API was wrong.
        const located = await deviceLocator.where({ q: { raw: value.device, value: value.device } }).catch(() => null);
        ctx = { located, query: value.device };
      } else {
        if (!probeResultsRepo) return res.status(503).json({ error: 'Probe results are not available' });
        const agent = await agentsRepo.findById(value.agentId);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        if (def.needs.agents >= 2) {
          const peer = await agentsRepo.findById(value.peerAgentId);
          if (!peer) return res.status(404).json({ error: 'Peer agent not found' });
          const here = addressOf(agent);
          const there = addressOf(peer);
          const [mine, theirs] = await Promise.all([rowsFor(value.agentId), rowsFor(value.peerAgentId)]);
          // Each direction is the rows the near end holds ABOUT the far end's
          // address — rows about anything else are a different question.
          ctx = {
            forward: there ? mine.filter((r) => targetHost(r) === there) : [],
            reverse: here ? theirs.filter((r) => targetHost(r) === here) : [],
            fromName: nameOf(agent),
            toName: nameOf(peer),
          };
        } else if (def.id === ladders.LOCAL_HOST) {
          // The agent's own interfaces, from the same computation the
          // Interfaces screen and the fleet rollup use.
          let interfaces = null;
          if (interfaceHealthFor) interfaces = await interfaceHealthFor(value.agentId).catch(() => null);
          ctx = { interfaces, results: await rowsFor(value.agentId) };
        } else {
          const results = await rowsFor(value.agentId);
          // ARP is only answerable for an address, and only from the agent's
          // own neighbour table. A name has not resolved to anything yet as far
          // as that rung is concerned.
          const arp = net.isIP(value.host) !== 0
            ? await arpContext({ arpRepo: arpEntriesRepo, agentId: value.agentId, ip: value.host })
            : null;
          ctx = { results, host: value.host, arp };
        }
      }

      const config = await ladderConfig(def.id);
      res.json({
        agentId: value.agentId || null,
        peerAgentId: value.peerAgentId || null,
        host: value.host || null,
        device: value.device || null,
        ...ladders.walk({ ladder: def, ctx, config, locale: value.locale, symptom: value.symptom }),
      });
    })
  );

  // Save the same test as a recurring test package, so it survives the tab
  // being closed and shows up beside every other scheduled test. `runs` repeats
  // the whole selection within one scheduled run (the dialog's "tests per run").
  router.post(
    '/schedule',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!testPackagesRepo) return res.status(503).json({ error: 'Test packages are not available' });
      const { value, errors } = validateConnectionTestSchedule(req.body);
      if (errors) return validationError(res, errors);

      const agent = await agentsRepo.findById(value.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      // A scheduled connection test is an enabled test package, so it consumes
      // an active-test-path slot like any other — the same graceful 403 as
      // POST /api/test-packages, rather than a way around the plan.
      if (usageService) {
        const check = await usageService.assertWithinLimit('test_paths');
        if (!check.ok) return res.status(403).json(check.body);
      }

      const { specs, skipped } = specsFor(value.host, value.checks);
      if (!specs.length) {
        return res.status(400).json({
          error: 'Validation failed',
          details: { checks: 'none of the selected checks can run against this target' },
          skipped,
        });
      }

      const items = [];
      for (let round = 0; round < value.runs; round += 1) {
        for (const s of specs) items.push({ type: 'probe', probe: s.probe });
      }

      // Built here, then put through the ordinary package validator — a
      // connection-test package is a test package, and it has to satisfy the
      // same contract as one an operator builds by hand.
      const { value: pkg, errors: pe } = validateTestPackageInput({
        name: value.name || `Connection test — ${value.host}`,
        enabled: true,
        schedule_spec: value.recurrence,
        targets: { mode: 'agents', agentIds: [value.agentId] },
        items,
      });
      if (pe) return validationError(res, pe);

      const created = await testPackagesRepo.create({ ...pkg, created_by: req.user ? req.user.id : null });
      res.status(201).json({ ...created, skipped });
    })
  );

  return router;
}

module.exports = { createConnectionTestRouter };
