'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateQuery } = require('../search/query');
const { DEFAULT_LIMIT, MAX_LIMIT } = require('../search/searchService');

// Universal search (Fase 1) — one field that takes what the technician actually
// knows (an IP, a MAC, a hostname, a site, an agent, a service) and lands them
// on the right screen. viewer+.
//
// The resolver fan-out, its priority order and the partial-failure policy live
// in src/search/searchService.js; this router is the HTTP edge: validate, rate
// limit, delegate, shape the response.
//
// Response:
//   { query, hits[], total, truncated, partial, failedSources[], unresolved[] }
// Each hit: { type, display_name, target, confidence, source, last_seen, detail? }
//
// `source` and `last_seen` ride on every hit deliberately — the technician must
// be able to see whether an answer rests on data from yesterday or from three
// weeks ago before they drive to a site on the strength of it.
function createSearchRouter({ searchService, rateLimiter = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);

  // Rate limited because this is a global field wired to a keyboard shortcut:
  // one fan-out touches several tables and (when a CMDB is configured) makes an
  // outbound HTTP call to the customer's ServiceNow. The UI debounces, but the
  // endpoint must not depend on the client behaving.
  const limiter = typeof rateLimiter === 'function' ? rateLimiter : (req, res, next) => next();

  router.get('/', requireAuth, reader, limiter, asyncHandler(async (req, res) => {
    const { value: q, error } = validateQuery(req.query.q);
    if (error) return res.status(400).json({ error });

    // limit is optional; an out-of-range value is a client error rather than
    // something to silently clamp, so a broken caller finds out.
    let limit = DEFAULT_LIMIT;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ error: `limit must be an integer 1..${MAX_LIMIT}` });
      }
    }

    const result = await searchService.search(q, { limit });

    // An empty result set is 200 with an empty list, never 404: "nothing matched"
    // is a successful answer to a search, and a 404 would read to the client as
    // "the search endpoint is gone".
    return res.json(result);
  }));

  return router;
}

module.exports = { createSearchRouter };
