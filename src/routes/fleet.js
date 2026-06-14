'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { computeFleet, computeAgentHealth, mergeHealth, mergeThroughput } = require('../health/probeHealth');
const { interfaceHealthSummary } = require('../health/interfaceHealth');
const { throughputHealthSummary } = require('../health/throughputHealth');
const { computeDataQuality } = require('../health/dataQuality');
const { computeNicInventory } = require('../health/nicInventory');
const { silentLogger } = require('../logger');

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
function createFleetRouter({ agentsRepo, probeResultsRepo, resultsRepo, speedtestResultsRepo = null, settingsService = null, logger = silentLogger }) {
  const router = express.Router();

  // Latest result row per agent, keyed by agent id. Best-effort: a results read
  // failure must not sink the overview, just drop the interface/quality dimensions.
  async function latestPerAgentMap() {
    if (!resultsRepo || !resultsRepo.latestPerAgent) return {};
    let latest;
    try { latest = await resultsRepo.latestPerAgent(); } catch (err) { logger.warn(`fleet: latestPerAgent read failed (${err.message}); dropping interface/quality dimensions`); return {}; }
    const out = {};
    for (const row of latest || []) out[row.agent_id] = row;
    return out;
  }

  // Latest speed test per agent + the (opt-in) throughput thresholds. Best-effort:
  // any failure just drops the throughput dimension from the verdict.
  async function throughputContext() {
    let throughputByAgentId = {};
    let throughputThresholds = null;
    if (speedtestResultsRepo && speedtestResultsRepo.latestPerAgent) {
      try {
        const rows = await speedtestResultsRepo.latestPerAgent();
        for (const r of rows || []) throughputByAgentId[r.agent_id] = r;
      } catch (err) { logger.warn(`fleet: speedtest latestPerAgent read failed (${err.message}); dropping throughput dimension`); throughputByAgentId = {}; }
    }
    if (settingsService && settingsService.getThroughput) {
      try { throughputThresholds = await settingsService.getThroughput(); } catch (err) { logger.warn(`fleet: throughput thresholds read failed (${err.message})`); throughputThresholds = null; }
    }
    return { throughputByAgentId, throughputThresholds };
  }

  router.get('/health', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const windowMs = parseWindow(req.query.windowMin);
    const [agents, rows, latestMap, thrCtx] = await Promise.all([
      agentsRepo.findAll(),
      probeResultsRepo.fleetHealth({ windowMs }),
      latestPerAgentMap(),
      throughputContext(),
    ]);
    const byAgent = {};
    for (const r of rows) {
      if (!byAgent[r.agentId]) byAgent[r.agentId] = [];
      byAgent[r.agentId].push(r);
    }
    const ifaceByAgentId = {};
    for (const [aid, row] of Object.entries(latestMap)) {
      const summ = interfaceHealthSummary(row.payload && row.payload.traffic);
      if (summ) ifaceByAgentId[aid] = summ;
    }
    const { agents: fleet, summary } = computeFleet(agents, byAgent, {
      ifaceByAgentId,
      throughputByAgentId: thrCtx.throughputByAgentId,
      throughputThresholds: thrCtx.throughputThresholds,
    });
    // Per-agent data-quality (agent version from capabilities + latest payload).
    const capsById = {};
    for (const a of agents) capsById[a.id] = a.capabilities || null;
    for (const a of fleet) {
      const latest = latestMap[a.agentId];
      a.quality = computeDataQuality({ capabilities: capsById[a.agentId], latest: latest ? { payload: latest.payload, created_at: latest.created_at } : null });
    }
    res.json({ windowMin: Math.round(windowMs / 60000), summary, agents: fleet });
  }));

  // Fleet-wide NIC inventory + firmware-drift detection: groups identical NIC
  // models across all agents and flags firmware-version outliers (the "3 of 50
  // units on a different firmware" case). Reads each agent's reported
  // capabilities.nic — no probes, no new storage. viewer+.
  router.get('/nics', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const agents = await agentsRepo.findAll();
    res.json(computeNicInventory(agents));
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
    const [rows, latest, speed, thresholds] = await Promise.all([
      probeResultsRepo.findByAgent({ agentId, from: new Date(Date.now() - windowMs), limit: 2000 }),
      resultsRepo && resultsRepo.findByAgentId ? resultsRepo.findByAgentId(agentId, { limit: 1 }) : Promise.resolve([]),
      speedtestResultsRepo && speedtestResultsRepo.findByAgent ? speedtestResultsRepo.findByAgent(agentId, 1).catch(() => []) : Promise.resolve([]),
      settingsService && settingsService.getThroughput ? settingsService.getThroughput().catch(() => null) : Promise.resolve(null),
    ]);
    const probe = computeAgentHealth(rows.slice().reverse());
    const iface = interfaceHealthSummary(latest && latest[0] && latest[0].payload && latest[0].payload.traffic);
    let health = mergeHealth(probe, iface);
    const latestSpeed = speed && speed[0] ? speed[0] : null;
    const thr = throughputHealthSummary(latestSpeed, thresholds || {});
    if (thr) health = mergeThroughput(health, thr);
    const quality = computeDataQuality({
      capabilities: agent.capabilities || null,
      latest: latest && latest[0] ? { payload: latest[0].payload, created_at: latest[0].created_at } : null,
    });
    const throughput = latestSpeed
      ? { downMbps: latestSpeed.down_mbps != null ? Number(latestSpeed.down_mbps) : null, upMbps: latestSpeed.up_mbps != null ? Number(latestSpeed.up_mbps) : null, ts: latestSpeed.ts || null, ok: latestSpeed.ok === 1 || latestSpeed.ok === true }
      : null;
    res.json({ agentId, displayName: agent.display_name || agent.hostname, health, quality, throughput });
  }));

  return router;
}

module.exports = { createFleetRouter };
