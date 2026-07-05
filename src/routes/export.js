'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { toCsv } = require('../lib/csv');
const { computeAgentHealth, mergeHealth } = require('../health/probeHealth');
const { interfaceHealthSummary, computeInterfaceHealth } = require('../health/interfaceHealth');
const { computeDataQuality } = require('../health/dataQuality');

const DAY_MS = 24 * 60 * 60 * 1000;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function parseDate(value, field) {
  if (value === undefined || value === '') return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} must be a valid date`);
  return d;
}

function parseIntParam(value, field) {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(String(value))) throw badRequest(`${field} must be an integer`);
  return Number(value);
}

// Simple CSV/JSON export. GET /api/export/:resource?format=csv|json (+ filters).
// Read-only (viewer+). Each resource yields { columns, rows }; geo is gated by
// the geo license feature (so this isn't a way around /api/geo's 403).
function createExportRouter({ findingStore, flowsRepo, agentsRepo, locationsRepo, resultsRepo, probeResultsRepo, featureGate }) {
  const router = express.Router();
  const safe = (p, d) => Promise.resolve(p).then((x) => x).catch(() => d);

  // GET /api/export/investigation?agentId=&from=&to=&format=json|csv — a single
  // archivable artifact for one agent: its health + data-quality verdict,
  // interface health, latest probes, recent findings and top flow talkers/scans.
  // JSON = the rich bundle; CSV = a flattened finding+probe event log. viewer+.
  // Registered before /:resource so it isn't swallowed by the generic handler.
  router.get('/investigation', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const agentId = parseIntParam(req.query.agentId, 'agentId');
    if (agentId === undefined) throw badRequest('agentId is required');
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const to = parseDate(req.query.to, 'to') || new Date();
    const from = parseDate(req.query.from, 'from') || new Date(to.getTime() - DAY_MS);

    const probeRows = probeResultsRepo ? await safe(probeResultsRepo.findByAgent({ agentId, from, to, limit: 2000 }), []) : [];
    const latestProbes = probeResultsRepo ? await safe(probeResultsRepo.latestByAgent(agentId), []) : [];
    const latestResults = await safe(resultsRepo.findByAgentId(agentId, { limit: 1 }), []);
    const latest = latestResults && latestResults[0];
    const traffic = latest && latest.payload && latest.payload.traffic;
    const interfaces = computeInterfaceHealth(traffic);
    const health = mergeHealth(computeAgentHealth((probeRows || []).slice().reverse()), interfaceHealthSummary(traffic));
    const quality = computeDataQuality({ capabilities: agent.capabilities || null, latest: latest ? { payload: latest.payload, created_at: latest.created_at } : null });
    const findings = findingStore ? await safe(findingStore.list(String(agentId), from), []) : [];
    let flows = { topTalkers: [], scans: [] };
    if (flowsRepo && typeof flowsRepo.exploreFlows === 'function') {
      const f = await safe(flowsRepo.exploreFlows({ agentId, from, to, bucketSec: 3600 }), null);
      if (f) flows = { topTalkers: (f.topTalkers || []).slice(0, 20), scans: f.scans || [] };
    }

    const base = `blueeye-investigation-${agentId}`;
    const format = String(req.query.format || 'json').toLowerCase();
    if (format === 'csv') {
      const events = [];
      for (const f of findings || []) events.push({ ts: f.createdAt, source: 'finding', kind: f.severity, subject: f.metric, detail: f.explanation });
      for (const p of latestProbes || []) events.push({ ts: p.ts, source: `probe:${p.type}`, kind: p.ok ? 'ok' : 'fail', subject: p.target, detail: [p.rttMs != null ? `${p.rttMs}ms` : null, p.lossPct != null ? `loss ${p.lossPct}%` : null].filter(Boolean).join(' ') });
      events.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${base}.csv"`);
      return res.send(toCsv(['ts', 'source', 'kind', 'subject', 'detail'], events));
    }
    if (format !== 'json') return res.status(400).json({ error: 'format must be csv or json' });
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${base}.json"`);
    return res.json({
      generatedAt: new Date().toISOString(),
      window: { from: from.toISOString(), to: to.toISOString() },
      agent: { id: agent.id, hostname: agent.hostname, displayName: agent.display_name || agent.hostname, locationName: agent.location_name || null, status: agent.status, version: quality.version },
      health, quality, interfaces, latestProbes, findings, flows,
    });
  }));

  const resources = {
    findings: {
      columns: ['id', 'createdAt', 'hostId', 'metric', 'severity', 'kind', 'observed', 'baseline', 'deviation', 'explanation', 'correlatedWith', 'acked'],
      fetch: async (req) => {
        const hostId = req.query.hostId ? String(req.query.hostId) : undefined;
        const since = parseDate(req.query.since, 'since');
        return findingStore.list(hostId, since);
      },
    },
    geo: {
      feature: 'geo',
      columns: ['country', 'asn', 'asnName', 'bytes', 'flowCount', 'deviation'],
      fetch: async (req) => {
        const until = new Date();
        const since = parseDate(req.query.since, 'since') || new Date(until.getTime() - 7 * DAY_MS);
        const agentId = parseIntParam(req.query.hostId, 'hostId') ?? null;
        return flowsRepo.aggregateExternalDestinations({ agentId, since, until });
      },
    },
    agents: {
      columns: ['id', 'hostname', 'display_name', 'platform', 'arch', 'status', 'location_name', 'last_report_at'],
      fetch: async () => (await agentsRepo.findAll()).map((a) => ({
        id: a.id, hostname: a.hostname, display_name: a.display_name, platform: a.platform,
        arch: a.arch, status: a.status, location_name: a.location_name, last_report_at: a.last_report_at,
      })),
    },
    locations: {
      columns: ['id', 'name', 'address', 'latitude', 'longitude'],
      fetch: async () => (await locationsRepo.findAll()).map((l) => ({
        id: l.id, name: l.name, address: l.address ?? null, latitude: l.latitude ?? null, longitude: l.longitude ?? null,
      })),
    },
    traffic: {
      columns: ['agentId', 'at', 'cpu', 'mem', 'load1', 'rxBytesPerSec', 'txBytesPerSec'],
      fetch: async (req) => {
        const agentId = parseIntParam(req.query.agentId, 'agentId');
        if (agentId === undefined) throw badRequest('agentId is required');
        const range = { from: parseDate(req.query.from, 'from') || null, to: parseDate(req.query.to, 'to') || null, limit: 5000 };
        const rows = await resultsRepo.findByAgentId(agentId, range);
        return rows.map((r) => {
          const p = r.payload || {};
          const sys = p.system || {};
          const tot = (p.traffic && p.traffic.totals) || {};
          return {
            agentId: r.agent_id,
            at: r.created_at,
            cpu: sys.cpuPercent ?? null,
            mem: sys.memUsedPercent ?? null,
            load1: Array.isArray(sys.loadavg) ? sys.loadavg[0] : null,
            rxBytesPerSec: tot.rxBytesPerSec ?? null,
            txBytesPerSec: tot.txBytesPerSec ?? null,
          };
        });
      },
    },
  };

  router.get(
    '/:resource',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      // Own-property lookup only: a bare index would walk the prototype chain,
      // so /export/constructor would pass the guard and 500 on .fetch().
      const resource = Object.prototype.hasOwnProperty.call(resources, req.params.resource)
        ? resources[req.params.resource]
        : null;
      if (!resource) return res.status(404).json({ error: 'Unknown export resource' });

      if (resource.feature && featureGate && !featureGate.isFeatureEnabled(resource.feature)) {
        return res.status(403).json({ error: 'This feature is not included in your license', feature: resource.feature, reason: 'license' });
      }

      // Validate format before the (potentially expensive) fetch.
      const format = String(req.query.format || 'json').toLowerCase();
      if (format !== 'csv' && format !== 'json') {
        return res.status(400).json({ error: 'format must be csv or json' });
      }

      const rows = await resource.fetch(req); // may throw a 400 for bad params
      const filename = `blueeye-${req.params.resource}`;

      if (format === 'csv') {
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return res.send(toCsv(resource.columns, rows));
      }
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${filename}.json"`);
      return res.json(rows);
    })
  );

  return router;
}

module.exports = { createExportRouter };
