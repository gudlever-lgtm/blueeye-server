'use strict';

const express = require('express');
const { createHealthRouter } = require('./health');
const { createAuthRouter } = require('./auth');
const { createUsersRouter } = require('./users');
const { createLocationsRouter } = require('./locations');
const { createAgentsRouter } = require('./agents');
const { createAgentEnrollRouter } = require('./agentEnroll');
const { createAgentReportsRouter } = require('./agentReports');
const { createEnrollmentCodesRouter } = require('./enrollmentCodes');
const { createLicenseRouter } = require('./license');
const { createSystemRouter } = require('./system');
const { createFindingsRouter } = require('./findings');
const { createAssistantRouter } = require('./assistant');
const { createGeoRouter } = require('./geo');
const { createAlertingRouter } = require('./alerting');
const { createExportRouter } = require('./export');
const {
  createAgentAuthenticator,
  createAgentTokenMiddleware,
} = require('../auth/agentAuth');

// Aggregates the feature routers into a single API router. New resources are
// mounted here, keeping the app factory (src/app.js) small.
function createApiRouter({
  db,
  locationsRepo,
  usersRepo,
  agentsRepo,
  enrollmentCodesRepo,
  enrollmentStore,
  agentTokensRepo,
  resultsRepo,
  licenseManager,
  agentCommander,
  systemInfo,
  findingStore,
  analysisPipeline,
  flowPipeline,
  flowsRepo,
  geoTileConfig,
  assistant,
  dispatcher,
  featureGate,
}) {
  const router = express.Router();

  // Agent-token middleware — kept entirely separate from the user JWT auth.
  const agentAuthenticator = createAgentAuthenticator({ agentTokensRepo });
  const agentAuth = createAgentTokenMiddleware({
    authenticator: agentAuthenticator,
    agentTokensRepo,
    agentsRepo,
  });

  router.use('/health', createHealthRouter({ db }));
  router.use('/auth', createAuthRouter({ usersRepo }));
  router.use('/users', createUsersRouter({ usersRepo }));
  router.use('/locations', createLocationsRouter({ locationsRepo, resultsRepo }));
  router.use('/license', createLicenseRouter({ licenseManager, featureGate }));
  router.use('/system', createSystemRouter({ systemInfo }));
  if (findingStore) router.use('/api/findings', createFindingsRouter({ findingStore }));
  if (assistant) router.use('/api/assistant', createAssistantRouter({ assistant, featureGate }));
  if (flowsRepo) router.use('/api/geo', createGeoRouter({ flowsRepo, agentsRepo, findingStore, tileConfig: geoTileConfig, featureGate }));
  if (dispatcher) router.use('/api/alerting', createAlertingRouter({ dispatcher }));
  router.use('/api/export', createExportRouter({ findingStore, flowsRepo, agentsRepo, locationsRepo, resultsRepo, featureGate }));
  router.use('/enrollment-codes', createEnrollmentCodesRouter({ enrollmentCodesRepo, locationsRepo }));

  // Three routers share the /agents prefix, each with its own auth model:
  //   - CRUD + results listing — user JWT (RBAC)
  //   - POST /results          — agent token
  //   - POST /enroll           — unauthenticated
  // Requests fall through routers that have no matching route.
  router.use('/agents', createAgentsRouter({ agentsRepo, locationsRepo, resultsRepo, agentCommander }));
  router.use('/agents', createAgentReportsRouter({ agentAuth, resultsRepo, agentsRepo, analysisPipeline, flowPipeline }));
  router.use('/agents', createAgentEnrollRouter({ enrollmentStore }));

  return router;
}

module.exports = { createApiRouter };
