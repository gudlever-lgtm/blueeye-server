'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// Map tile + geocoder config for the UI (viewer+). Deliberately NOT gated by the
// geo license feature: the location editor's map picker needs it for basic
// location management even when the geo analytics module isn't licensed.
function createMapRouter({ getMapConfig }) {
  const router = express.Router();

  router.get(
    '/config',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      res.json(getMapConfig ? await getMapConfig() : {});
    })
  );

  return router;
}

module.exports = { createMapRouter };
