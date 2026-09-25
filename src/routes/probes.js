'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateTimeRange } = require('../validation/resultsValidation');
const { parseId } = require('../validation/locationValidation');
const { buildPathGraph, PATH_PROBE_TYPES } = require('../analysis/pathGraph');
const { summarise, withRouteChanges, diffRuns } = require('../analysis/pathHistory');
const { agentPosition } = require('../geo/agentPosition');
const { asGraphFromNodes } = require('../analysis/asPath');
const { METRICS, getMetric, bucketMetric } = require('../analysis/pathTimeseries');

// Read API for active-probe results (ping/tcp/dns/traceroute/tcptraceroute). viewer+.
// geoProvider/cityProvider/centroids are optional — when wired, the path graph
// enriches public hop IPs with GeoIP/ASN and places them on the map (router name
// → city GeoIP → country, src/geo/hopLocation.js); without them the graph is
// metrics-only.
function createProbesRouter({ probeResultsRepo, agentsRepo, geoProvider = null, cityProvider = null, centroids = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);

  // Which kind of trace the path views are showing. `traceroute` (ICMP/UDP) is
  // the default; `tcptraceroute` traces the same path with TCP SYNs. They are
  // never merged into one graph — a path that goes dark for ICMP while TCP walks
  // through is exactly the comparison an operator is making, so the two stay
  // side by side rather than averaged together.
  const pathProbeType = (raw) => {
    const t = String(raw || '').toLowerCase();
    return PATH_PROBE_TYPES.includes(t) ? t : 'traceroute';
  };

  // The most recent target of that trace type for an agent, so /path can default
  // to "show me the latest path" when no target is given.
  const latestTarget = (rows, type) => {
    for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].type === type) return rows[i].target;
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
  // `asGraph` is the same path collapsed to AS hops (the observed forwarding
  // AS-path) for the dashboard's "AS view".
  router.get('/path', requireAuth, reader, asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const { value: range, errors } = validateTimeRange(req.query);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const samples = Math.max(1, Math.min(50, Number.parseInt(req.query.samples, 10) || 10));
    const probeType = pathProbeType(req.query.probeType);
    const rows = await probeResultsRepo.findByAgent({ agentId, from: range.from, to: range.to, type: probeType, limit: 500 });
    let target = req.query.target ? String(req.query.target).slice(0, 255) : latestTarget(rows, probeType);
    // Newest `samples` runs for that target (rows arrive oldest-first), or the
    // ONE stored run asked for: a history is only worth keeping if a run in it
    // can be opened as it was, rather than as part of a median.
    const runId = req.query.runId ? parseId(req.query.runId) : null;
    let runs;
    if (runId !== null) {
      const one = await probeResultsRepo.findRunById(runId, { agentId });
      if (!one || !PATH_PROBE_TYPES.includes(one.type)) return res.status(404).json({ error: 'Run not found' });
      runs = [one];
      target = one.target;
    } else {
      runs = rows.filter((r) => r.target === target).slice(-samples);
    }
    // The agent's own position when set, else its site's (src/geo/agentPosition.js).
    const pos = agentPosition(agent);
    const origin = {
      lat: pos ? pos.lat : null,
      lng: pos ? pos.lng : null,
      source: pos ? pos.source : null,
      label: agent.display_name || agent.hostname || 'Agent',
    };
    const graph = buildPathGraph(runs, { geoProvider, cityProvider, centroids, target, origin });
    // `origin` rides along even when there are no runs yet, so a live trace
    // can anchor its first hops to the agent's site before anything is stored.
    res.json({ agentId, probeType, runId, origin, ...graph, asGraph: asGraphFromNodes(graph.nodes) });
  }));

  // GET /api/probes/path/metrics — the metric catalogue for the timeline's
  // selector (extensible list, per the spec). No agent needed; viewer+.
  router.get('/path/metrics', requireAuth, reader, asyncHandler(async (_req, res) => {
    res.json({ metrics: METRICS.map((m) => ({ id: m.id, label: m.label, unit: m.unit, render: m.render })) });
  }));

  // GET /api/probes/path/runs?agentId=&target=&probeType=&from=&to=&limit=&offset=
  // Every stored run of one traced path, newest-first, one row each — the
  // history behind the aggregated graph. Each row says whether that run took a
  // DIFFERENT route from the run before it in time, which is the thing a reader
  // scans a trace history for. viewer+.
  router.get('/path/runs', requireAuth, reader, asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const { value: range, errors } = validateTimeRange(req.query);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const probeType = pathProbeType(req.query.probeType);
    let target = req.query.target ? String(req.query.target).slice(0, 255) : null;
    if (!target) {
      const recent = await probeResultsRepo.findByAgent({ agentId, from: range.from, to: range.to, type: probeType, limit: 500 });
      target = latestTarget(recent, probeType);
    }
    if (!target) return res.json({ agentId, probeType, target: null, total: 0, limit: 0, offset: 0, runs: [] });
    const limit = Math.max(1, Math.min(200, Number.parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const q = { agentId, type: probeType, target, from: range.from, to: range.to };
    const [rows, total] = await Promise.all([
      probeResultsRepo.listRuns({ ...q, limit, offset }),
      probeResultsRepo.countRuns(q),
    ]);
    // The page's own oldest run has no predecessor INSIDE the page, so the one
    // before it is fetched: otherwise the first row of every page but the last
    // would read as "no change" whether or not it was one.
    const oldest = rows.length ? rows[rows.length - 1] : null;
    const prior = oldest
      ? await probeResultsRepo.previousRun({ agentId, type: probeType, target, beforeTs: oldest.ts, beforeId: oldest.id })
      : null;
    // The page's own ids decide what is returned: the extra run is context, and
    // an id set says so whether or not the store handed back one already here.
    const pageIds = new Set(rows.map((r) => r.id));
    const withContext = prior && !pageIds.has(prior.id) ? [prior, ...rows] : rows;
    const runs = withRouteChanges(withContext).filter((r) => pageIds.has(r.id));
    res.json({ agentId, probeType, target, total, limit, offset, runs });
  }));

  // GET /api/probes/path/compare?agentId=&runId=&againstRunId=
  // Two stored runs of the same path, hop by hop. Without `againstRunId` the
  // run before `runId` is used, because "what changed since last time" is the
  // question asked far more often than any particular pair. viewer+.
  router.get('/path/compare', requireAuth, reader, asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const runId = parseId(req.query.runId);
    if (runId === null) return res.status(400).json({ error: 'runId is required (positive integer)' });
    if (!(await agentsRepo.findById(agentId))) return res.status(404).json({ error: 'Agent not found' });
    const after = await probeResultsRepo.findRunById(runId, { agentId });
    if (!after || !PATH_PROBE_TYPES.includes(after.type)) return res.status(404).json({ error: 'Run not found' });

    let before;
    if (req.query.againstRunId) {
      const otherId = parseId(req.query.againstRunId);
      if (otherId === null) return res.status(400).json({ error: 'againstRunId must be a positive integer' });
      before = await probeResultsRepo.findRunById(otherId, { agentId });
      if (!before) return res.status(404).json({ error: 'Run not found' });
      // Comparing two different paths would produce a diff in which every hop
      // changed, which says nothing about either of them.
      if (before.target !== after.target || before.type !== after.type) {
        return res.status(400).json({ error: 'Both runs must be the same probe to the same target' });
      }
    } else {
      before = await probeResultsRepo.previousRun({ agentId, type: after.type, target: after.target, beforeTs: after.ts, beforeId: after.id });
      if (!before) return res.json({ agentId, target: after.target, probeType: after.type, before: null, after: summarise(after), diff: null });
    }
    // Oldest first, whichever way round they were asked for: "changed" only
    // means anything in one direction.
    const [older, newer] = new Date(before.ts) <= new Date(after.ts) ? [before, after] : [after, before];
    res.json({
      agentId,
      target: newer.target,
      probeType: newer.type,
      before: summarise(older),
      after: summarise(newer),
      diff: diffRuns(older, newer),
    });
  }));

  // GET /api/probes/path/timeseries?agentId=&target=&metric=&overlay=&bucket=&from=&to=
  // Bucketed metric series for the path timeline (overview strip + detail chart).
  // `overlay=agents` returns one series per probing agent to that target; the
  // brush window (from/to) is the caller's single source of truth. Empty window
  // ⇒ empty `series` array, not null.
  router.get('/path/timeseries', requireAuth, reader, asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const { value: range, errors } = validateTimeRange(req.query);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const metric = getMetric(req.query.metric || 'latency');
    if (!metric) return res.status(400).json({ error: `Unknown metric: ${req.query.metric}` });
    const overlay = String(req.query.overlay || 'off').toLowerCase() === 'agents' ? 'agents' : 'off';
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Default the target to the agent's most recent trace of that type, matching /path.
    const probeType = pathProbeType(req.query.probeType);
    let target = req.query.target ? String(req.query.target).slice(0, 255) : null;
    if (!target) {
      const recent = await probeResultsRepo.findByAgent({ agentId, from: range.from, to: range.to, type: probeType, limit: 500 });
      target = latestTarget(recent, probeType);
    }
    if (!target) return res.json({ agentId, target: null, overlay, metric: metric.id, series: [] });

    const rows = await probeResultsRepo.metricRows({
      target,
      agentId: overlay === 'agents' ? null : agentId,
      from: range.from,
      to: range.to,
    });
    const bucketMs = req.query.bucket ? (Number.parseInt(req.query.bucket, 10) || 0) * 1000 : null;
    const out = bucketMetric(rows, { from: range.from, to: range.to, bucketMs, metric, overlay });
    res.json({ agentId, target, overlay, ...out });
  }));

  return router;
}

module.exports = { createProbesRouter };
