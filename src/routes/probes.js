'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateTimeRange } = require('../validation/resultsValidation');
const { parseId } = require('../validation/locationValidation');
const { buildPathGraph } = require('../analysis/pathGraph');

// Read API for active-probe results (ping/tcp/dns/traceroute). viewer+.
// geoProvider/centroids are optional — when wired, the path graph enriches public
// hop IPs with GeoIP/ASN; without them the graph is metrics-only.
function createProbesRouter({ probeResultsRepo, agentsRepo, geoProvider = null, centroids = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);

  // The most recent traceroute target for an agent, so /path can default to
  // "show me the latest path" when no target is given.
  const latestTarget = (rows) => {
    for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].type === 'traceroute') return rows[i].target;
    return null;
  };

  // GET /api/probes?agentId=&from=&to=&type= — time series (oldest first).
  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const { value: range, errors } = validateTimeRange(req.query);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const type = req.query.type ? String(req.query.type).toLowerCase() : null;
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const results = await probeResultsRepo.findByAgent({ agentId, from: range.from, to: range.to, type, limit: range.limit });
    res.json({ agentId, type, results });
  }));

  // GET /api/probes/latest?agentId= — most recent result per (type, target).
  router.get('/latest', requireAuth, reader, asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json({ agentId, results: await probeResultsRepo.latestByAgent(agentId) });
  }));

  // GET /api/probes/path?agentId=&target=&samples=&from=&to= — aggregates the
  // recent traceroutes to one target into a directed, weighted hop graph with
  // per-hop loss/latency/jitter (+ GeoIP/ASN) for the path-visualisation map.
  router.get('/path', requireAuth, reader, asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const { value: range, errors } = validateTimeRange(req.query);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const samples = Math.max(1, Math.min(50, Number.parseInt(req.query.samples, 10) || 10));
    const rows = await probeResultsRepo.findByAgent({ agentId, from: range.from, to: range.to, type: 'traceroute', limit: 500 });
    const target = req.query.target ? String(req.query.target).slice(0, 255) : latestTarget(rows);
    // Newest `samples` runs for that target (rows arrive oldest-first).
    const runs = rows.filter((r) => r.target === target).slice(-samples);
    const graph = buildPathGraph(runs, { geoProvider, centroids, target });
    res.json({ agentId, ...graph });
  }));

  return router;
}

module.exports = { createProbesRouter };
