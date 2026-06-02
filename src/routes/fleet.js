'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { computeFleet, computeAgentHealth, mergeHealth } = require('../health/probeHealth');
const { interfaceHealthSummary } = require('../health/interfaceHealth');

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

// Fleet health overview: every agent with a health verdict — its active-probe
// signals (reachability + loss + latency-vs-baseline + jitter) folded together
// with its interface signal (link/errors/discards/util) — worst-first. viewer+.
// Reads all agents + one windowed probe query + the latest result per agent; no
// new storage.
function createFleetRouter({ agentsRepo, probeResultsRepo, resultsRepo }) {
  const router = express.Router();

  // Latest interface signal per agent, keyed by agent id (omits agents with no
  // traffic measurement). Best-effort: a results read failure must not sink the
  // whole overview, just drop the interface dimension.
  async function ifaceByAgentId() {
    if (!resultsRepo || !resultsRepo.latestPerAgent) return {};
    let latest;
    try { latest = await resultsRepo.latestPerAgent(); } catch { return {}; }
    const out = {};
    for (const row of latest || []) {
      const summ = interfaceHealthSummary(row.payload && row.payload.traffic);
      if (summ) out[row.agent_id] = summ;
    }
    return out;
  }

  router.get('/health', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const windowMs = parseWindow(req.query.windowMin);
    const [agents, rows, ifaces] = await Promise.all([
      agentsRepo.findAll(),
      probeResultsRepo.fleetHealth({ windowMs }),
      ifaceByAgentId(),
    ]);
    const byAgent = {};
    for (const r of rows) {
      if (!byAgent[r.agentId]) byAgent[r.agentId] = [];
      byAgent[r.agentId].push(r);
    }
    const { agents: fleet, summary } = computeFleet(agents, byAgent, { ifaceByAgentId: ifaces });
    res.json({ windowMin: Math.round(windowMs / 60000), summary, agents: fleet });
  }));

  // One agent's health verdict — for the combined agent page. Reuses the
  // per-agent probe history (findByAgent returns oldest-first; the health
  // computation wants newest-first) and folds in its interface signal.
  router.get('/agent/:id', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const agentId = parseId(req.params.id);
    if (agentId === null) return res.status(400).json({ error: 'agentId must be a positive integer' });
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const windowMs = parseWindow(req.query.windowMin);
    const [rows, latest] = await Promise.all([
      probeResultsRepo.findByAgent({ agentId, from: new Date(Date.now() - windowMs), limit: 2000 }),
      resultsRepo && resultsRepo.findByAgentId ? resultsRepo.findByAgentId(agentId, { limit: 1 }) : Promise.resolve([]),
    ]);
    const probe = computeAgentHealth(rows.slice().reverse());
    const iface = interfaceHealthSummary(latest && latest[0] && latest[0].payload && latest[0].payload.traffic);
    const health = mergeHealth(probe, iface);
    res.json({ agentId, displayName: agent.display_name || agent.hostname, health });
  }));

  return router;
}

module.exports = { createFleetRouter };
