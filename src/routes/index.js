'use strict';

const express = require('express');
const { createHealthRouter } = require('./health');
const { createAuthRouter } = require('./auth');
const { createUsersRouter } = require('./users');
const { createLocationsRouter } = require('./locations');

// Aggregates the feature routers into a single API router. New resources are
// mounted here, keeping the app factory (src/app.js) small.
function createApiRouter({ db, locationsRepo, usersRepo }) {
  const router = express.Router();

  router.use('/health', createHealthRouter({ db }));
  router.use('/auth', createAuthRouter({ usersRepo }));
  router.use('/users', createUsersRouter({ usersRepo }));
  router.use('/locations', createLocationsRouter({ locationsRepo }));

  return router;
}

module.exports = { createApiRouter };
