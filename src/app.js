'use strict';

const path = require('path');
const express = require('express');
const { createApiRouter } = require('./routes');
const { requestLogger } = require('./middleware/requestLogger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { silentLogger } = require('./logger');

// Builds the Express application. Dependencies (db + repositories + logger) are
// injected so the same factory powers both the real server and the test suite.
// It deliberately does NOT call listen() — that belongs to src/server.js.
function createApp({
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
  testPackagesRepo,
  testPackageRunner,
  speedtestResultsRepo,
  enrollConfig,
  notifyDashboard,
  logger = silentLogger,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  // Behind a reverse proxy: trust X-Forwarded-* so req.protocol/host reflect the
  // public origin (used to build enrollment URLs).
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger(logger));

  // Static admin dashboard (vanilla HTML/JS). Served before the API router;
  // requests that don't match a file fall through to the JSON API.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Application routes. User-JWT RBAC and agent-token auth are enforced inside
  // the individual routers (see src/auth/* and src/routes/*).
  app.use(
    '/',
    createApiRouter({
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
      testPackagesRepo,
      testPackageRunner,
      speedtestResultsRepo,
      enrollConfig,
      notifyDashboard,
    })
  );

  // 404 + centralised error handling, always mounted last.
  app.use(notFoundHandler);
  app.use(errorHandler({ logger }));

  return app;
}

module.exports = { createApp };
