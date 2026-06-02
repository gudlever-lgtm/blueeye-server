'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { computeFleet, computeAgentHealth } = require('../health/probeHealth');

const DEFAULT_WINDOW_MS = 6 * 3600 * 1000;
const MAX_WINDOW_MS = 7 * 24 * 3600 * 1000;

function parseId(v) {
  if (!/^\d+$/.test(String(v))) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseWindow(v) {
  if (v === undefined) return DEFAULT_WINDOW_MS;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_MS;
  return Math.min(n * 60 * 1000, MAX_WINDOW_MS); // query is in minutes
}

// Fleet health overview: every agent with a probe-derived health verdict
// (reachability + loss + latency-vs-baseline + jitter), worst-first. viewer+.
// Reads all agents + one windowed probe query, then derives verdicts in JS — no
// new storage.
function createFleetRouter({ agentsRepo, probeResultsRepo }) {
  const router = express.Router();
  router.get('/health', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const windowMs = parseWindow(req.query.windowMin);
    const [agents, rows] = await Promise.all([
      agentsRepo.findAll(),
      probeResultsRepo.fleetHealth({ windowMs }),
    ]);
    const byAgent = {};
    for (const r of rows) {
      const k = r.agentId;
      if (!byAgent[k]) byAgent[k] = [];
      byAgent[k].push(r);
    }
    const { agents: fleet, summary } = computeFleet(agents, byAgent);
    res.json({ windowMin: Math.round(windowMs / 60000), summary, agents: fleet });
  }));

  // One agent's health verdict — for the combined agent page. Reuses the
  // per-agent probe history (findByAgent returns oldest-first; the health
  // computation wants newest-first).
  router.get('/agent/:id', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const agentId = parseId(req.params.id);
    if (agentId === null) return res.status(400).json({ error: 'agentId must be a positive integer' });
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const windowMs = parseWindow(req.query.windowMin);
    const rows = await probeResultsRepo.findByAgent({ agentId, from: new Date(Date.now() - windowMs), limit: 2000 });
    const health = computeAgentHealth(rows.slice().reverse());
    res.json({ agentId, displayName: agent.display_name || agent.hostname, health });
  }));
  return router;
}

module.exports = { createFleetRouter };
