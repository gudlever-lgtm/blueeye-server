'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateLocationInput, parseId } = require('../validation/locationValidation');

// Locations CRUD router with role-based access control:
//   - viewer   may read           (GET)
//   - operator may create/edit     (POST, PUT)  — and read
//   - admin    may delete          (DELETE)     — and everything above
//
// Authorization is applied per route (rather than router-wide) so that a
// request to an unknown sub-path still falls through to the 404 handler.
function createLocationsRouter({ locationsRepo, resultsRepo }) {
  const router = express.Router();

  // GET /locations — any authenticated role.
  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const locations = await locationsRepo.findAll();
      res.json(locations);
    })
  );

  // GET /locations/:id/traffic — correlated (aggregated) live traffic for all
  // agents in the location: per-agent latest measurement + summed totals.
  // viewer+. Declared before /:id so it isn't shadowed by other routes.
  router.get(
    '/:id/traffic',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const location = await locationsRepo.findById(id);
      if (!location) {
        return res.status(404).json({ error: 'Location not found' });
      }

      const rows = await resultsRepo.latestByLocation(id);
      const totals = { rxBytes: 0, txBytes: 0, rxBytesPerSec: 0, txBytesPerSec: 0 };
      let reporting = 0;

      const agents = rows.map((row) => {
        const t = row.payload && row.payload.traffic && row.payload.traffic.totals;
        if (t) {
          reporting += 1;
          totals.rxBytes += Number(t.rxBytes) || 0;
          totals.txBytes += Number(t.txBytes) || 0;
          totals.rxBytesPerSec += Number(t.rxBytesPerSec) || 0;
          totals.txBytesPerSec += Number(t.txBytesPerSec) || 0;
        }
        return {
          agentId: row.agent_id,
          hostname: row.hostname,
          displayName: row.display_name,
          status: row.status,
          at: row.created_at,
          rxBytesPerSec: t ? Number(t.rxBytesPerSec) || 0 : null,
          txBytesPerSec: t ? Number(t.txBytesPerSec) || 0 : null,
        };
      });

      res.json({
        locationId: location.id,
        locationName: location.name,
        agentCount: agents.length,
        reportingCount: reporting,
        at: new Date().toISOString(),
        totals,
        agents,
      });
    })
  );

  // POST /locations — operator or admin.
  router.post(
    '/',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const { value, errors } = validateLocationInput(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const created = await locationsRepo.create(value);
      res.status(201).json(created);
    })
  );

  // PUT /locations/:id — operator or admin.
  router.put(
    '/:id',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const { value, errors } = validateLocationInput(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const updated = await locationsRepo.update(id, value);
      if (!updated) {
        return res.status(404).json({ error: 'Location not found' });
      }
      res.json(updated);
    })
  );

  // DELETE /locations/:id — admin only.
  router.delete(
    '/:id',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const removed = await locationsRepo.remove(id);
      if (!removed) {
        return res.status(404).json({ error: 'Location not found' });
      }
      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createLocationsRouter };
