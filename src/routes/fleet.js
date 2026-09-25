'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { computeFleet, computeAgentHealth, mergeHealth, mergeThroughput, mergeConnection } = require('../health/probeHealth');
const { interfaceHealthSummary } = require('../health/interfaceHealth');
const { throughputHealthSummary } = require('../health/throughputHealth');
const { computeDataQuality } = require('../health/dataQuality');
const { computeNicInventory } = require('../health/nicInventory');
const { healthSignature, applyAck, isAckable } = require('../health/healthAck');
const { silentLogger } = require('../logger');
const { parseId } = require('../validation/locationValidation');

const DEFAULT_WINDOW_MS = 6 * 3600 * 1000;
const MAX_WINDOW_MS = 7 * 24 * 3600 * 1000;

function parseWindow(v) {
  if (v === undefined) return DEFAULT_WINDOW_MS;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_MS;
  return Math.min(n * 60 * 1000, MAX_WINDOW_MS); // query is in minutes
}

// Optional `severity` query param on the fleet overview: the dashboard filters
// client-side for normal fleets, but for large fleets (>500 agents) it offloads
// the severity filter to the server as `?severity=CRIT,WARN` to shrink the
// payload. We map the dashboard's severity tokens onto the health statuses they
// stand for (CRIT ⇒ bad/down, WARN ⇒ warn). This is deliberately forgiving:
// unknown tokens (e.g. `?severity=BOGUS`) are ignored rather than rejected, so a
// bad or stale deep-link degrades to "no filter" (200 + the whole fleet) instead
// of a 400/500. Returns a Set of statuses to keep, or null for "no filtering".
const SEVERITY_STATUSES = { CRIT: ['bad', 'down'], WARN: ['warn'] };
function parseSeverityParam(v) {
  if (v === undefined || v === null) return null;
  const statuses = new Set();
  for (const raw of String(v).split(',')) {
    const mapped = SEVERITY_STATUSES[raw.trim().toUpperCase()];
    if (mapped) for (const s of mapped) statuses.add(s);
  }
  return statuses.size ? statuses : null; // no valid tokens ⇒ don't filter
}

// Fleet health overview: every agent with a health verdict — its active-probe
// signals (reachability + loss + latency-vs-baseline + jitter) folded together
// with its interface signal (link/errors/discards/util) — worst-first. viewer+.
// Reads all agents + one windowed probe query + the latest result per agent; no
// new storage.
function createFleetRouter({
  agentsRepo, probeResultsRepo, resultsRepo, speedtestResultsRepo = null, settingsService = null,
  healthAcksRepo = null, auditLogger = null, logger = silentLogger,
}) {
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

  // Every live acknowledgement, keyed by agent id. Best-effort, like every other
  // dimension here: a failed read means the rollup shows nothing as
  // acknowledged, never that the rollup fails.
  async function acksById() {
    if (!healthAcksRepo || !healthAcksRepo.findAll) return {};
    try { return await healthAcksRepo.findAll(); } catch (err) {
      logger.warn(`fleet: health acknowledgements read failed (${err.message}); showing none as acknowledged`);
      return {};
    }
  }

  // ONE agent's verdict, computed exactly as the fleet rollup computes it.
  // Shared by GET /agent/:id and the acknowledge route, so what gets
  // acknowledged is the verdict the reader was looking at — an ack route that
  // signed the client's idea of the verdict would let a stale tab clear a
  // problem that has since changed.
  async function agentVerdict(agent, windowMs = DEFAULT_WINDOW_MS) {
    const [rows, latest, speed, thresholds] = await Promise.all([
      probeResultsRepo.findByAgent({ agentId: agent.id, from: new Date(Date.now() - windowMs), limit: 2000 }),
      resultsRepo && resultsRepo.findByAgentId ? resultsRepo.findByAgentId(agent.id, { limit: 1 }) : Promise.resolve([]),
      speedtestResultsRepo && speedtestResultsRepo.findByAgent ? speedtestResultsRepo.findByAgent(agent.id, 1).catch(() => []) : Promise.resolve([]),
      settingsService && settingsService.getThroughput ? settingsService.getThroughput().catch(() => null) : Promise.resolve(null),
    ]);
    const probe = computeAgentHealth(rows.slice().reverse());
    const iface = interfaceHealthSummary(latest && latest[0] && latest[0].payload && latest[0].payload.traffic);
    let health = mergeHealth(probe, iface);
    const latestSpeed = speed && speed[0] ? speed[0] : null;
    const thr = throughputHealthSummary(latestSpeed, thresholds || {});
    if (thr) health = mergeThroughput(health, thr);
    health = mergeConnection(health, agent.status === 'offline');
    return { health, latest, latestSpeed };
  }

  router.get('/health', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const windowMs = parseWindow(req.query.windowMin);
    const [agents, rows, latestMap, thrCtx, acks] = await Promise.all([
      agentsRepo.findAll(),
      probeResultsRepo.fleetHealth({ windowMs }),
      latestPerAgentMap(),
      throughputContext(),
      acksById(),
    ]);
    const byAgent = {};
    for (const r of rows) {
      if (!byAgent[r.agentId]) byAgent[r.agentId] = [];
      byAgent[r.agentId].push(r);
    }
    const ifaceByAgentId = {};
    for (const [aid, row] of Object.entries(latestMap)) {
      // Per-agent isolation: a single agent's malformed payload must degrade
      // only its own row, never 500 the fleet-wide rollup for every operator.
      try {
        const summ = interfaceHealthSummary(row.payload && row.payload.traffic);
        if (summ) ifaceByAgentId[aid] = summ;
      } catch (err) {
        logger.warn(`fleet: interface health for agent ${aid} failed (${err.message}); dropping its interface dimension`);
      }
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
      // An acknowledgement annotates the verdict; it never changes it. The
      // status, the summary counts and the worst-first sort are what they were,
      // so a cleared agent is still a CRIT agent — it just says who has it.
      a.health = applyAck(a.health, acks[a.agentId] || null);
    }
    // How many of the current verdicts are acknowledged, for the "3 of 7
    // cleared" line. Counted from the merged list rather than from the table,
    // so an acknowledgement made for a verdict that has since moved is not
    // counted — it no longer applies.
    summary.acknowledged = fleet.filter((a) => a.health && a.health.ack).length;
    // `summary` always reflects the WHOLE fleet (so the dashboard's metric-card
    // counts stay honest); only the returned `agents` list is narrowed when a
    // valid severity filter is supplied.
    const sevFilter = parseSeverityParam(req.query.severity);
    const agentsOut = sevFilter ? fleet.filter((a) => sevFilter.has(a.health.status)) : fleet;
    res.json({ windowMin: Math.round(windowMs / 60000), summary, agents: agentsOut });
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
    const { health: computed, latest, latestSpeed } = await agentVerdict(agent, parseWindow(req.query.windowMin));
    let health = computed;
    if (healthAcksRepo && healthAcksRepo.findByAgent) {
      try { health = applyAck(health, await healthAcksRepo.findByAgent(agentId)); } catch (err) {
        logger.warn(`fleet: acknowledgement read for agent ${agentId} failed (${err.message})`);
      }
    }
    const quality = computeDataQuality({
      capabilities: agent.capabilities || null,
      latest: latest && latest[0] ? { payload: latest[0].payload, created_at: latest[0].created_at } : null,
    });
    const throughput = latestSpeed
      ? { downMbps: latestSpeed.down_mbps != null ? Number(latestSpeed.down_mbps) : null, upMbps: latestSpeed.up_mbps != null ? Number(latestSpeed.up_mbps) : null, ts: latestSpeed.ts || null, ok: latestSpeed.ok === 1 || latestSpeed.ok === true }
      : null;
    res.json({ agentId, displayName: agent.display_name || agent.hostname, health, quality, throughput });
  }));

  // ---------------------------------------------------------------- acknowledge
  //
  // "Somebody is on this." A CRIT verdict on Fleet is derived from live
  // measurements, so it cannot be closed the way an event is — it clears when
  // the measurements clear. What a shift needs in the meantime is a way to say
  // the row has been seen and is being handled, and that is what these two
  // routes write (migration 138).
  //
  // The verdict is recomputed HERE rather than taken from the request: the
  // signature stored is the one the server currently stands behind, so a tab
  // left open overnight cannot clear this morning's problem with last night's.
  // A verdict that moves afterwards re-opens the row on its own.
  //
  // operator+ — the same footing as running a test on the agent. Acknowledging
  // never touches alerting: the rules that page people are in severity_rules
  // and alert_rules and are not read here.
  router.post('/health/:id/ack', requireAuth, requireRole(ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const agentId = parseId(req.params.id);
    if (agentId === null) return res.status(400).json({ error: 'agentId must be a positive integer' });
    const note = req.body && req.body.note != null ? String(req.body.note).trim() : '';
    if (note.length > 255) return res.status(400).json({ error: 'note must be 255 characters or fewer' });
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!healthAcksRepo || !healthAcksRepo.set) return res.status(503).json({ error: 'Acknowledgements are not available' });
    const { health } = await agentVerdict(agent);
    // A healthy agent has nothing to acknowledge, and an agent that has never
    // reported must not be clearable — acknowledging "no data yet" would hide
    // the one agent nobody has heard from.
    if (!isAckable(health.status)) {
      return res.status(409).json({ error: `Nothing to acknowledge — this agent's verdict is "${health.status}"`, status: health.status });
    }
    const ack = await healthAcksRepo.set({
      agentId,
      signature: healthSignature(health),
      status: health.status,
      note: note || null,
      ackedBy: req.user && req.user.id ? Number(req.user.id) : null,
      ackedEmail: (req.user && req.user.email) || null,
    });
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'agent',
        action: 'agent_health_ack',
        target: String(agentId),
        detail: `status=${health.status} reason="${String(health.reason || '').slice(0, 160)}"${note ? ` note="${note.slice(0, 80)}"` : ''}`,
      });
    }
    return res.status(201).json({ agentId, health: applyAck(health, ack) });
  }));

  // Undo. 404 when the agent was never acknowledged, so "clear" on a row that
  // somebody else already un-acknowledged says so instead of reporting success.
  router.delete('/health/:id/ack', requireAuth, requireRole(ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const agentId = parseId(req.params.id);
    if (agentId === null) return res.status(400).json({ error: 'agentId must be a positive integer' });
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!healthAcksRepo || !healthAcksRepo.clear) return res.status(503).json({ error: 'Acknowledgements are not available' });
    const removed = await healthAcksRepo.clear(agentId);
    if (!removed) return res.status(404).json({ error: 'This agent is not acknowledged' });
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'agent', action: 'agent_health_unack', target: String(agentId), detail: 'acknowledgement removed',
      });
    }
    return res.status(204).end();
  }));

  return router;
}

module.exports = { createFleetRouter };
