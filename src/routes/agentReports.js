'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateResults } = require('../validation/resultsValidation');
const { validateCapabilities } = require('../validation/agentValidation');

// Endpoints agents call themselves, authenticated with their opaque token
// (NOT a user JWT). `agentAuth` is the agent-token middleware. The agent id is
// taken from the token (req.agent.agentId), so an agent can only ever read/write
// its OWN config/capabilities/results — never another agent's.
//
// Paths use the `/me/...` prefix so they don't collide with the user-JWT agents
// router's `/:id` routes mounted under the same /agents path.
function createAgentReportsRouter({ agentAuth, resultsRepo, agentsRepo, analysisPipeline = null, flowPipeline = null }) {
  const router = express.Router();

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
