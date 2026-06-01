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
  licenseManager,
  agentCommander,
  systemInfo,
  findingStore,
  analysisPipeline,
  assistant,
  logger = silentLogger,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
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
      licenseManager,
      agentCommander,
      systemInfo,
      findingStore,
      analysisPipeline,
      assistant,
    })
  );

  // 404 + centralised error handling, always mounted last.
  app.use(notFoundHandler);
  app.use(errorHandler({ logger }));

  return app;
}

module.exports = { createApp };
