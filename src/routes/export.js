'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { toCsv } = require('../lib/csv');

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
function createExportRouter({ findingStore, flowsRepo, agentsRepo, locationsRepo, resultsRepo, featureGate }) {
  const router = express.Router();

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
      const resource = resources[req.params.resource];
      if (!resource) return res.status(404).json({ error: 'Unknown export resource' });

      if (resource.feature && featureGate && !featureGate.isFeatureEnabled(resource.feature)) {
        return res.status(403).json({ error: 'Funktionen er ikke inkluderet i jeres licens', feature: resource.feature, reason: 'license' });
      }

      const rows = await resource.fetch(req); // may throw a 400 for bad params
      const format = String(req.query.format || 'json').toLowerCase();
      const filename = `blueeye-${req.params.resource}`;

      if (format === 'csv') {
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return res.send(toCsv(resource.columns, rows));
      }
      if (format !== 'json') return res.status(400).json({ error: 'format must be csv or json' });
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${filename}.json"`);
      return res.json(rows);
    })
  );

  return router;
}

module.exports = { createExportRouter };
