'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateLocationInput, parseId } = require('../validation/locationValidation');

// Locations CRUD router.
//
// RBAC arrives in prompt 2. The endpoints are intentionally open for now, but
// authorization can be slotted in without touching the handlers — either
// per-router (router.use(authenticate)) or per-route, e.g.:
//     router.post('/', authorize('admin'), asyncHandler(...))
function createLocationsRouter({ locationsRepo }) {
  const router = express.Router();

  // GET /locations
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const locations = await locationsRepo.findAll();
      res.json(locations);
    })
  );

  // POST /locations
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const { value, errors } = validateLocationInput(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const created = await locationsRepo.create(value);
      res.status(201).json(created);
    })
  );

  // PUT /locations/:id
  router.put(
    '/:id',
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

  // DELETE /locations/:id
  router.delete(
    '/:id',
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
