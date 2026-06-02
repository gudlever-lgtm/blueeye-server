'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateTimeRange } = require('../validation/resultsValidation');
const { listCategories, buildIndex, classifyPort, classifyAsn } = require('../flows/categories');
const { parseId } = require('../validation/locationValidation');

// Filter sanitisers for the conversation explorer. Everything is bound as a
// query parameter regardless; these just reject obviously-bad input early.
function parsePort(v) {
  if (v === undefined || v === '') return { ok: true, value: null };
  if (!/^\d+$/.test(String(v))) return { ok: false };
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? { ok: true, value: n } : { ok: false };
}
function cleanProto(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(s) ? s : null;
}
function cleanPeer(v) {
  const s = String(v || '').trim();
  return /^[0-9a-fA-F.:]{1,45}$/.test(s) ? s : null; // IPv4/IPv6 literal characters only
}

const TARGET_BUCKETS = 60;
const MIN_BUCKET_MS = 60 * 1000;
const DEFAULT_SPAN_MS = 6 * 60 * 60 * 1000; // last 6h when no range is given

// Traffic-type breakdown over time, for ONE agent. Port categories (DNS, Web,
// ...) come from the agent's `byPort` summary (stored result payloads);
// organisation categories (Facebook, Google, ...) come from the destination ASN
// of geo-enriched flows. Both are metadata only — no payload/DPI. viewer+.
function createFlowsRouter({ resultsRepo, agentsRepo, flowsRepo, getCategories }) {
  const router = express.Router();
  // Categories are loaded per request so admin edits (via settings) take effect
  // without a restart. Falls back to the built-in defaults.
  const loadCategories = typeof getCategories === 'function' ? getCategories : async () => listCategories();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);

  // Catalogue of categories (so the UI can build toggles before/independently of
  // a data fetch).
  router.get('/categories/defs', requireAuth, reader, asyncHandler(async (_req, res) => {
    const categories = await loadCategories();
    res.json({ categories: categories.map(({ id, label, kind }) => ({ id, label, kind })) });
  }));

  // GET /api/flows/categories?agentId=&from=&to= — time-bucketed bytes per
  // traffic-type category. Only categories with traffic in the window are
  // returned (biggest first); `points` align with `buckets`.
  router.get('/categories', requireAuth, reader, asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) {
      return res.status(400).json({ error: 'agentId is required (positive integer)' });
    }
    const { value: range, errors } = validateTimeRange(req.query);
    if (errors) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    const agent = await agentsRepo.findById(agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const categories = await loadCategories();
    const index = buildIndex(categories);
    const byId = new Map(categories.map((c) => [c.id, c]));

    // Resolve the window and a bucket size aligned to the epoch grid, so the
    // SQL bucket index (FLOOR(ts/bucketSec)) and the JS one line up exactly.
    const toMs = range.to ? range.to.getTime() : Date.now();
    const fromMs = range.from ? range.from.getTime() : toMs - DEFAULT_SPAN_MS;
    const span = Math.max(MIN_BUCKET_MS, toMs - fromMs);
    let bucketMs = Math.ceil(span / TARGET_BUCKETS / 1000) * 1000;
    if (bucketMs < MIN_BUCKET_MS) bucketMs = MIN_BUCKET_MS;
    const bucketSec = Math.round(bucketMs / 1000);
    const firstBucket = Math.floor(fromMs / bucketMs);
    const lastBucket = Math.floor(toMs / bucketMs);
    const nBuckets = Math.max(1, lastBucket - firstBucket + 1);
    const buckets = [];
    for (let i = 0; i < nBuckets; i += 1) buckets.push(new Date((firstBucket + i) * bucketMs).toISOString());

    const seriesById = new Map();
    const ensure = (id) => {
      let a = seriesById.get(id);
      if (!a) { a = new Array(nBuckets).fill(0); seriesById.set(id, a); }
      return a;
    };
    const idxForMs = (ms) => Math.floor(ms / bucketMs) - firstBucket;
    const from = range.from || new Date(fromMs);
    const to = range.to || new Date(toMs);

    // --- Port categories from the agent's byPort summary (results payloads) ---
    const rows = await resultsRepo.findByAgentId(agentId, { from, to, limit: 5000 });
    for (const row of rows) {
      const traffic = row.payload && row.payload.traffic;
      const byPort = traffic && Array.isArray(traffic.byPort) ? traffic.byPort : null;
      if (!byPort) continue;
      const ms = row.created_at instanceof Date ? row.created_at.getTime() : new Date(row.created_at).getTime();
      const bi = idxForMs(ms);
      if (bi < 0 || bi >= nBuckets) continue;
      for (const e of byPort) {
        const catId = classifyPort(e.port, index);
        if (!catId) continue;
        ensure(catId)[bi] += Number(e.bytes) || 0;
      }
    }

    // --- Organisation categories from flow ASNs (geo-enriched flow_records) ---
    // Best-effort: if geo is off / the table is empty / a query fails, port
    // categories are still returned.
    if (flowsRepo && typeof flowsRepo.asnSeries === 'function') {
      let asnRows = [];
      try {
        asnRows = await flowsRepo.asnSeries({ agentId, from, to, bucketSec });
      } catch {
        asnRows = [];
      }
      for (const r of asnRows) {
        const catId = classifyAsn(r.asn, index);
        if (!catId) continue;
        const bi = (Number(r.bucket) || 0) - firstBucket;
        if (bi < 0 || bi >= nBuckets) continue;
        ensure(catId)[bi] += Number(r.bytes) || 0;
      }
    }

    const out = [];
    for (const [id, points] of seriesById) {
      const total = points.reduce((s, v) => s + v, 0);
      if (total <= 0) continue;
      const c = byId.get(id);
      out.push({ id, label: c ? c.label : id, kind: c ? c.kind : null, total, points });
    }
    out.sort((a, b) => b.total - a.total);

    res.json({
      agentId,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      bucketMs,
      buckets,
      categories: out,
    });
  }));

  // GET /api/flows/explore?agentId=&from=&to=&port=&proto=&peer=&direction=&internal=
  // Conversation explorer: top talkers (src↔dst), top ports/protocols, a byte
  // series, and port-scan / fan-out candidates for ONE agent. Metadata only;
  // includes internal (RFC1918) conversations (never geolocated). viewer+.
  router.get('/explore', requireAuth, reader, asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const { value: range, errors } = validateTimeRange(req.query);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const portParsed = parsePort(req.query.port);
    if (!portParsed.ok) return res.status(400).json({ error: 'port must be an integer 1–65535' });

    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const proto = req.query.proto ? cleanProto(req.query.proto) : null;
    const peer = req.query.peer ? cleanPeer(req.query.peer) : null;
    const direction = (req.query.direction === 'in' || req.query.direction === 'out') ? req.query.direction : null;
    const internal = req.query.internal === 'internal' ? true : (req.query.internal === 'external' ? false : null);

    const toMs = range.to ? range.to.getTime() : Date.now();
    const fromMs = range.from ? range.from.getTime() : toMs - DEFAULT_SPAN_MS;
    // ~60 buckets, at least a minute each.
    const bucketSec = Math.max(60, Math.round((toMs - fromMs) / 1000 / TARGET_BUCKETS));

    const empty = { topTalkers: [], byPort: [], byProto: [], series: [], scans: [], totals: { bytes: 0, packets: 0, flowCount: 0, records: 0 } };
    const data = (flowsRepo && typeof flowsRepo.exploreFlows === 'function')
      ? await flowsRepo.exploreFlows({ agentId, from: new Date(fromMs), to: new Date(toMs), proto, port: portParsed.value, peer, direction, internal, bucketSec })
      : empty;

    res.json({
      agentId,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      filter: { port: portParsed.value, proto, peer, direction, internal: req.query.internal || null },
      ...data,
    });
  }));

  return router;
}

module.exports = { createFlowsRouter };
