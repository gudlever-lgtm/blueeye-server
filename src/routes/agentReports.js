'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateResults } = require('../validation/resultsValidation');
const { validateCapabilities } = require('../validation/agentValidation');
const { validateProbeResults } = require('../validation/probeValidation');

// Endpoints agents call themselves, authenticated with their opaque token
// (NOT a user JWT). `agentAuth` is the agent-token middleware. The agent id is
// taken from the token (req.agent.agentId), so an agent can only ever read/write
// its OWN config/capabilities/results — never another agent's.
//
// Paths use the `/me/...` prefix so they don't collide with the user-JWT agents
// router's `/:id` routes mounted under the same /agents path.
function createAgentReportsRouter({ agentAuth, resultsRepo, agentsRepo, auditEventsRepo = null, analysisPipeline = null, flowPipeline = null, probeResultsRepo = null, probePipeline = null, incidentService = null }) {
  const router = express.Router();

  // Records what an agent actually performed in the unified audit trail. Recurring
  // activity (continuous traffic reporting, scheduled probes) collapses onto a
  // single row via a dedup key — only the first run is a distinct audit entry,
  // every repeat just bumps it ("Repeats …"). Best-effort: never breaks ingest.
  async function auditAgentActivity(agentId, fn) {
    if (!auditEventsRepo) return;
    try { await fn(agentId); } catch { /* audit is non-fatal */ }
  }

  // A run-test triggered on demand (commanded) carries the command name; the
  // agent's own continuous reporting uses 'auto-report'. Only the latter repeats.
  function isAutoReport(r) {
    return !r || !r.name || r.name === 'auto-report';
  }

  // POST /agents/probe-results { results: [...] } — stores active-probe results
  // (ping/tcp/dns/traceroute/http) for the agent identified by the token.
  router.post(
    '/probe-results',
    agentAuth,
    asyncHandler(async (req, res) => {
      if (!probeResultsRepo) return res.status(404).json({ error: 'Probes not enabled' });
      const { value, errors } = validateProbeResults(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const inserted = await probeResultsRepo.createMany(req.agent.agentId, value.results);

      // Audit what the agent probed. Each (type → target) collapses to one row;
      // repeats (scheduled probes) bump it rather than spamming the trail. A
      // probe the agent could not EXECUTE at all (e.g. "traceroute not
      // installed") carries an explicit execError — audited distinctly as
      // 'agent.probe-failed' with the reason, so the trail shows the failure
      // (and why) instead of looking like a normal probe.
      await auditAgentActivity(req.agent.agentId, async (agentId) => {
        const seen = new Set();
        for (const r of value.results) {
          const type = r && r.type ? String(r.type) : 'probe';
          const target = r && r.target ? String(r.target) : '';
          const key = `${type}:${target}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (r && r.execError) {
            await auditEventsRepo.recordRecurring({
              actorType: 'agent', actorId: agentId,
              action: 'agent.probe-failed', targetType: type, targetLabel: target || null,
              detail: { reason: r.execError },
              dedupKey: `agent:${agentId}:probe-failed:${key}`,
            });
          } else {
            await auditEventsRepo.recordRecurring({
              actorType: 'agent', actorId: agentId,
              action: 'agent.probe', targetType: type, targetLabel: target || null,
              dedupKey: `agent:${agentId}:probe:${key}`,
            });
          }
        }
      });

      // After persistence, derive probe-based findings (reachability/loss/latency/
      // jitter/cert) and alert. Resilient: must never break ingestion.
      if (probePipeline) {
        try {
          await probePipeline.processAgent(req.agent.agentId);
        } catch {
          /* probe analysis is best-effort; ingestion already succeeded */
        }
      }

      // Derive incidents (open/resolve) from the agent's recent probe results.
      // Best-effort: must never break ingestion.
      if (incidentService) {
        try {
          await incidentService.processAgent(req.agent.agentId);
        } catch {
          /* incident derivation is best-effort; ingestion already succeeded */
        }
      }

      res.status(201).json({ inserted });
    })
  );

  // POST /agents/results { results: [...] } — stores results for the agent
  // identified by the token.
  router.post(
    '/results',
    agentAuth,
    asyncHandler(async (req, res) => {
      const { value, errors } = validateResults(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const inserted = await resultsRepo.createMany(req.agent.agentId, value.results);

      // Audit what the agent measured. Continuous reporting ('auto-report')
      // collapses onto a single recurring row ("Repeats …"); an on-demand
      // (commanded) run-test is recorded as a distinct event.
      await auditAgentActivity(req.agent.agentId, async (agentId) => {
        if (value.results.some((r) => isAutoReport(r))) {
          await auditEventsRepo.recordRecurring({
            actorType: 'agent', actorId: agentId,
            action: 'agent.traffic-report', targetType: 'traffic',
            dedupKey: `agent:${agentId}:traffic-report`,
          });
        }
        if (value.results.some((r) => !isAutoReport(r))) {
          await auditEventsRepo.record({
            actorType: 'agent', actorId: agentId,
            action: 'agent.run-test', targetType: 'traffic',
          });
        }
      });

      // After persistence, run analysis (behind its own feature flag). It is
      // resilient and must never break ingestion, so failures are swallowed.
      if (analysisPipeline) {
        try {
          await analysisPipeline.processResults(req.agent.agentId, value.results);
        } catch {
          /* analysis is best-effort; ingestion already succeeded */
        }
      }

      // Likewise, geo-enrich + store flow records (behind the geo flag).
      if (flowPipeline) {
        try {
          await flowPipeline.processResults(req.agent.agentId, value.results);
        } catch {
          /* flow enrichment is best-effort; ingestion already succeeded */
        }
      }

      res.status(201).json({ inserted });
    })
  );

  // GET /agents/me/config — the agent fetches its server-assigned monitoring
  // config. Defaults to the local /proc source when nothing is set.
  router.get(
    '/me/config',
    agentAuth,
    asyncHandler(async (req, res) => {
      const agent = await agentsRepo.findById(req.agent.agentId);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      res.json({
        agentId: agent.id,
        monitorConfig: agent.monitor_config || { source: 'proc' },
      });
    })
  );

  // POST /agents/me/capabilities { capabilities } — the agent reports what it
  // can do (e.g. { sources: ['proc','snmp'] }).
  router.post(
    '/me/capabilities',
    agentAuth,
    asyncHandler(async (req, res) => {
      const errors = {};
      const capabilities = validateCapabilities(req.body && req.body.capabilities, errors);
      if (errors.capabilities) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const updated = await agentsRepo.setCapabilities(req.agent.agentId, capabilities);
      if (!updated) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      res.json({ agentId: updated.id, capabilities: updated.capabilities });
    })
  );

  return router;
}

module.exports = { createAgentReportsRouter };
