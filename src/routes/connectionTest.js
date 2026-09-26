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
const { walk } = require('../connectionTest/ladder');
const { arpContext } = require('../connectionTest/arpContext');
const {
  validateConnectionTestRun,
  validateConnectionTestSchedule,
  validateConnectionTestWalk,
  validateLadderQuery,
} = require('../validation/connectionTestValidation');
const { validateTestPackageInput } = require('../validation/testPackageValidation');

function createConnectionTestRouter({ agentsRepo, agentCommander, probeResultsRepo = null, arpEntriesRepo = null, testPackagesRepo = null, usageService = null, auditLogger = null }) {
  const router = express.Router();
  const validationError = (res, details) => res.status(400).json({ error: 'Validation failed', details });

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

      const agent = await agentsRepo.findById(value.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const { specs, skipped } = specsFor(value.host, CHECK_IDS);
      if (!specs.length) {
        return res.status(400).json({
          error: 'Validation failed',
          details: { host: 'no check in the catalogue can run against this target' },
          skipped,
        });
      }

      let delivered = 0;
      const dispatched = [];
      for (const s of specs) {
        const n = agentCommander ? agentCommander.sendCommand(value.agentId, { name: 'run-probe', probe: s.probe }) : 0;
        if (n > 0) { delivered += n; dispatched.push({ id: s.id, type: s.probe.type, port: s.probe.port || null }); }
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
          detail: JSON.stringify({ ladder: true, target: value.host, symptom: value.symptom || null, checks: dispatched.map((d) => d.id) }),
        });
      }

      res.status(202).json({
        agentId: value.agentId,
        host: value.host,
        symptom: value.symptom || null,
        delivered,
        dispatched,
        skipped,
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
      if (!probeResultsRepo) return res.status(503).json({ error: 'Probe results are not available' });
      const { value, errors } = validateLadderQuery(req.query);
      if (errors) return validationError(res, errors);

      const agent = await agentsRepo.findById(value.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      // Every probe type this destination could have produced, plus room for
      // the other targets the agent has tested — latestByAgent is one row per
      // (type, target) and the ladder filters to this destination itself.
      const results = await probeResultsRepo.latestByAgent(value.agentId, 200);
      // ARP is only answerable for an address, and only from the agent's own
      // neighbour table. A name has not resolved to anything yet as far as this
      // rung is concerned.
      const arp = net.isIP(value.host) !== 0
        ? await arpContext({ arpRepo: arpEntriesRepo, agentId: value.agentId, ip: value.host })
        : null;

      res.json({ agentId: value.agentId, ...walk({ results, host: value.host, arp, symptom: value.symptom }) });
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
