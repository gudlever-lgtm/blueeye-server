'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { requireFeature } = require('../license/features');

const DAY_MS = 24 * 60 * 60 * 1000;

// Geo / map API. All endpoints are viewer+ behind the user JWT and gated by the
// 'geo' license feature. Aggregation is done server-side — raw flow records
// never leave the server, and RFC1918/private endpoints are excluded at the
// data layer (internal = 0).
function createGeoRouter({ flowsRepo, agentsRepo, findingStore, tileConfig = {}, featureGate }) {
  const router = express.Router();
  // License gate for the whole module (403 when not included in the license).
  router.use(requireAuth, requireFeature(featureGate, 'geo'));
  const staff = [requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN)];

  // Resolves the [since, until] window from ?since=. until is "now". Returns
  // { since, until } or { error } for an invalid date.
  function parseWindow(query) {
    const until = new Date();
    let since = new Date(until.getTime() - DAY_MS);
    if (query.since !== undefined && query.since !== '') {
      const d = new Date(query.since);
      if (Number.isNaN(d.getTime())) return { error: 'since must be a valid date' };
      since = d;
    }
    return { since, until };
  }

  // Parses an optional country/asn selection. Returns { country, asn } or
  // { error } when neither is provided (selection endpoints require one).
  function parseSelection(query) {
    const country = query.country ? String(query.country).toUpperCase() : null;
    let asn = null;
    if (query.asn !== undefined && query.asn !== '') {
      if (!/^\d+$/.test(String(query.asn))) return { error: 'asn must be an integer' };
      asn = Number(query.asn);
    }
    if (!country && asn === null) return { error: 'country or asn is required' };
    return { country, asn };
  }

  // GET /api/geo/config — map tile source (so the frontend never hardcodes it).
  router.get('/config', ...staff, (req, res) => {
    res.json({
      tileUrl: tileConfig.tileUrl || '',
      attribution: tileConfig.tileAttribution || '',
      maxZoom: tileConfig.tileMaxZoom || 19,
    });
  });

  // GET /api/geo/overview?since=&hostId= — internal hosts (site metadata) +
  // external destinations (GeoIP-aggregated, no private addresses).
  router.get('/overview', ...staff, asyncHandler(async (req, res) => {
    const win = parseWindow(req.query);
    if (win.error) return res.status(400).json({ error: 'Validation failed', details: { since: win.error } });

    let hostId = null;
    if (req.query.hostId !== undefined && req.query.hostId !== '') {
      if (!/^\d+$/.test(String(req.query.hostId))) {
        return res.status(400).json({ error: 'Validation failed', details: { hostId: 'hostId must be an integer' } });
      }
      hostId = Number(req.query.hostId);
    }

    const [internalHosts, externalDestinations] = await Promise.all([
      agentsRepo.findForGeo(hostId),
      flowsRepo.aggregateExternalDestinations({ agentId: hostId, since: win.since, until: win.until }),
    ]);

    res.json({
      since: win.since.toISOString(),
      until: win.until.toISOString(),
      internalHosts,
      externalDestinations,
    });
  }));

  // GET /api/geo/select/findings?country=&asn=&since= — findings for the hosts
  // that talked to the selected destination. 404 when the destination is unknown.
  router.get('/select/findings', ...staff, asyncHandler(async (req, res) => {
    const win = parseWindow(req.query);
    if (win.error) return res.status(400).json({ error: 'Validation failed', details: { since: win.error } });
    const sel = parseSelection(req.query);
    if (sel.error) return res.status(400).json({ error: 'Validation failed', details: { selection: sel.error } });

    const exists = await flowsRepo.destinationExists({ ...sel, since: win.since, until: win.until });
    if (!exists) return res.status(404).json({ error: 'No traffic for the selected destination' });

    const agentIds = await flowsRepo.agentIdsForDestination({ ...sel, since: win.since, until: win.until });
    const findings = [];
    for (const id of agentIds) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await findingStore.list(String(id), win.since);
      for (const f of rows) findings.push(f);
    }
    findings.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    res.json({ country: sel.country, asn: sel.asn, since: win.since.toISOString(), until: win.until.toISOString(), hosts: agentIds, findings });
  }));

  // GET /api/geo/select/flows?country=&asn=&since= — aggregated flow detail for
  // the selected destination. 404 when the destination is unknown.
  router.get('/select/flows', ...staff, asyncHandler(async (req, res) => {
    const win = parseWindow(req.query);
    if (win.error) return res.status(400).json({ error: 'Validation failed', details: { since: win.error } });
    const sel = parseSelection(req.query);
    if (sel.error) return res.status(400).json({ error: 'Validation failed', details: { selection: sel.error } });

    const exists = await flowsRepo.destinationExists({ ...sel, since: win.since, until: win.until });
    if (!exists) return res.status(404).json({ error: 'No traffic for the selected destination' });

    const detail = await flowsRepo.selectFlows({ ...sel, since: win.since, until: win.until });
    res.json({ country: sel.country, asn: sel.asn, since: win.since.toISOString(), until: win.until.toISOString(), ...detail });
  }));

  return router;
}

module.exports = { createGeoRouter };
