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
const { createSettingsRouter } = require('./settings');
const { createMapRouter } = require('./map');
const { createFlowsRouter } = require('./flows');
const { createProbesRouter } = require('./probes');
const { createInterfacesRouter } = require('./interfaces');
const { createFleetRouter } = require('./fleet');
const { createSearchRouter } = require('./search');
const { createEnrollRouter } = require('./enroll');
const { createEnrollCommandRouter } = require('./enrollCommand');
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
  probeResultsRepo,
  licenseManager,
  agentCommander,
  systemInfo,
  findingStore,
  analysisPipeline,
  probePipeline,
  flowPipeline,
  flowsRepo,
  geoTileConfig,
  assistant,
  dispatcher,
  featureGate,
  settingsService,
  analysisConfig,
  retentionConfig,
  artifactStore,
  agentSourceStore,
  enrollConfig = {},
  notifyDashboard,
}) {
  const router = express.Router();
  // Effective (admin-editable) map config, used by both the geo view and the
  // ungated location-picker map. Falls back to the static tile config.
  const getMapConfig = settingsService
    ? () => settingsService.getMap()
    : () => Promise.resolve({ tileUrl: geoTileConfig && geoTileConfig.tileUrl, attribution: geoTileConfig && geoTileConfig.tileAttribution, maxZoom: geoTileConfig && geoTileConfig.tileMaxZoom });

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
  router.use('/system', createSystemRouter({ systemInfo, agentSourceStore }));
  if (findingStore) router.use('/api/findings', createFindingsRouter({ findingStore }));
  if (assistant) router.use('/api/assistant', createAssistantRouter({ assistant, featureGate }));
  if (flowsRepo) router.use('/api/geo', createGeoRouter({ flowsRepo, agentsRepo, findingStore, tileConfig: geoTileConfig, getMapConfig, featureGate }));
  if (dispatcher) router.use('/api/alerting', createAlertingRouter({ dispatcher }));
  router.use('/api/map', createMapRouter({ getMapConfig }));
  router.use('/api/flows', createFlowsRouter({
    resultsRepo, agentsRepo, flowsRepo,
    getCategories: settingsService ? () => settingsService.getFlowCategories() : undefined,
  }));
  if (probeResultsRepo) router.use('/api/probes', createProbesRouter({ probeResultsRepo, agentsRepo }));
  if (probeResultsRepo) router.use('/api/fleet', createFleetRouter({ agentsRepo, probeResultsRepo, resultsRepo }));
  router.use('/api/interfaces', createInterfacesRouter({ resultsRepo, agentsRepo }));
  router.use('/api/search', createSearchRouter({ agentsRepo, locationsRepo, flowsRepo }));
  if (settingsService) router.use('/api/settings', createSettingsRouter({ settingsService, featureGate, dispatcher, analysisConfig, retentionConfig }));
  router.use('/api/export', createExportRouter({ findingStore, flowsRepo, agentsRepo, locationsRepo, resultsRepo, probeResultsRepo, featureGate }));
  router.use('/enrollment-codes', createEnrollmentCodesRouter({ enrollmentCodesRepo, locationsRepo }));

  // Frictionless enrollment. Public (unauthenticated) source + install-script
  // endpoints under /enroll; the authenticated command generator under /api.
  if (artifactStore || agentSourceStore) {
    router.use('/enroll', createEnrollRouter({ artifactStore, sourceStore: agentSourceStore, enrollmentCodesRepo, enrollConfig }));
    router.use('/api/enroll', createEnrollCommandRouter({ enrollmentCodesRepo, artifactStore, sourceStore: agentSourceStore, enrollConfig }));
  }

  // Three routers share the /agents prefix, each with its own auth model:
  //   - CRUD + results listing — user JWT (RBAC)
  //   - POST /results          — agent token
  //   - POST /enroll           — unauthenticated
  // Requests fall through routers that have no matching route.
  router.use('/agents', createAgentsRouter({ agentsRepo, locationsRepo, resultsRepo, agentCommander }));
  router.use('/agents', createAgentReportsRouter({ agentAuth, resultsRepo, agentsRepo, analysisPipeline, flowPipeline, probeResultsRepo, probePipeline }));
  router.use('/agents', createAgentEnrollRouter({ enrollmentStore, notifyDashboard }));

  return router;
}

module.exports = { createApiRouter };
