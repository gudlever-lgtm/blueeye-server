'use strict';

const express = require('express');
const { createHealthRouter } = require('./health');
const { createAuthRouter } = require('./auth');
const { createUsersRouter } = require('./users');
const { createLocationsRouter } = require('./locations');
const { createAgentsRouter } = require('./agents');
const { createAgentEnrollRouter } = require('./agentEnroll');
const { createEnrollmentCodesRouter } = require('./enrollmentCodes');

// Aggregates the feature routers into a single API router. New resources are
// mounted here, keeping the app factory (src/app.js) small.
function createApiRouter({
  db,
  locationsRepo,
  usersRepo,
  agentsRepo,
  enrollmentCodesRepo,
  enrollmentStore,
}) {
  const router = express.Router();

  router.use('/health', createHealthRouter({ db }));
  router.use('/auth', createAuthRouter({ usersRepo }));
  router.use('/users', createUsersRouter({ usersRepo }));
  router.use('/locations', createLocationsRouter({ locationsRepo }));
  router.use('/enrollment-codes', createEnrollmentCodesRouter({ enrollmentCodesRepo, locationsRepo }));
  router.use('/agents', createAgentsRouter({ agentsRepo, locationsRepo }));
  // Unauthenticated agent self-enrollment, also under /agents. Mounted after
  // the (authenticated) agents router; POST /agents/enroll falls through to it.
  router.use('/agents', createAgentEnrollRouter({ enrollmentStore }));

  return router;
}

module.exports = { createApiRouter };
