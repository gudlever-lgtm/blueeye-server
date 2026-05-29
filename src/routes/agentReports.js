'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateResults } = require('../validation/resultsValidation');

// Endpoints agents call themselves, authenticated with their opaque token
// (NOT a user JWT). `agentAuth` is the agent-token middleware.
function createAgentReportsRouter({ agentAuth, resultsRepo }) {
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
      res.status(201).json({ inserted });
    })
  );

  return router;
}

module.exports = { createAgentReportsRouter };
