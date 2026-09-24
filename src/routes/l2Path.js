'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const {
  validateL2PathQuery, validateLocateQuery, validateInventoryQuery,
} = require('../validation/l2PathValidation');

// The L2 path and device-location reads (src/topology/deviceLocator.js,
// docs/l2-path.md). Two routers, because the questions live under two
// resources:
//
//   GET /api/topology/l2-path?from=&to=[&gateway=]   viewer+
//   GET /api/devices/locate?q=                         viewer+
//   GET /api/devices/inventory?limit=&offset=&kind=&q= operator+
//
// PATH AND LOCATE ARE VIEWER+: they answer one question about one or two
// endpoints the reader already knows, from the same tables universal search
// (viewer+) already answers "which port is this MAC on" from. THE INVENTORY
// IS OPERATOR+: it is the same facts for EVERY host at once — a complete list
// of what is plugged in where, which is an enumeration a read-only account
// does not need to do its job.
//
// 404 when an endpoint resolves to nothing this server has ever seen (the
// answer names which one); 503 when the install has no switch inventory or
// forwarding table to answer from at all, which is not the same as "not found".

const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
const operator = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

function createL2PathRouter({ deviceLocator }) {
  const router = express.Router();

  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    const v = validateL2PathQuery(req.query);
    if (v.errors) return res.status(400).json({ error: 'Validation failed', details: v.errors });
    const out = await deviceLocator.path(v.value);
    if (out.unavailable) {
      return res.status(503).json({ error: 'No switch inventory or forwarding table is collected on this server' });
    }
    if (out.notFound) {
      return res.status(404).json({
        error: 'Endpoint not found',
        details: Object.fromEntries(out.notFound.map((k) => [k, `${v.value[k].raw} is not known to this server (no agent, switch, ARP, forwarding-table or discovery record)`])),
      });
    }
    return res.json(out);
  }));

  return router;
}

function createDeviceLocateRouter({ deviceLocator }) {
  const router = express.Router();

  router.get('/locate', requireAuth, reader, asyncHandler(async (req, res) => {
    const v = validateLocateQuery(req.query);
    if (v.errors) return res.status(400).json({ error: 'Validation failed', details: v.errors });
    const out = await deviceLocator.where(v.value);
    if (!out) {
      return res.status(404).json({
        error: 'Device not found',
        details: { q: `${v.value.q.raw} is not known to this server (no agent, switch, ARP, forwarding-table or discovery record)` },
      });
    }
    return res.json(out);
  }));

  router.get('/inventory', requireAuth, operator, asyncHandler(async (req, res) => {
    const v = validateInventoryQuery(req.query);
    if (v.errors) return res.status(400).json({ error: 'Validation failed', details: v.errors });
    return res.json(await deviceLocator.inventory(v.value));
  }));

  return router;
}

module.exports = { createL2PathRouter, createDeviceLocateRouter };
