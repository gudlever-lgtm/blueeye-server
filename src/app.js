'use strict';

const path = require('path');
const express = require('express');
const { createApiRouter } = require('./routes');
const { requestLogger } = require('./middleware/requestLogger');
const { createAuditLogger } = require('./middleware/auditLogger');
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
  auditRepo,
  auditEventsRepo,
  auditLogRepo,
  apiTokensRepo,
  auditLogger,
  enrollmentCodesRepo,
  enrollmentStore,
  agentTokensRepo,
  resultsRepo,
  probeResultsRepo,
  incidentsRepo,
  thresholdsRepo,
  incidentService,
  installToolService,
  licenseManager,
  agentCommander,
  systemInfo,
  findingStore,
  analysisPipeline,
  probePipeline,
  flowPipeline,
  flowsRepo,
  geoTileConfig,
  geoProvider,
  geoipUpdater,
  centroids,
  assistant,
  dispatcher,
  featureGate,
  planService,
  usageService,
  settingsService,
  analysisConfig,
  retentionConfig,
  artifactStore,
  agentSourceStore,
  releaseStore,
  releasePublicKey,
  releaseKeyService,
  testPackagesRepo,
  testPackageRunner,
  speedtestResultsRepo,
  integrationsRepo,
  integrationAuditRepo,
  integrationsDispatcher,
  connectorRegistry,
  secretBox,
  ldapConfigRepo,
  ldapRoleMapRepo,
  ldapLoginAuditRepo,
  ldapAuth,
  ldapAuthEnabledFlag,
  nis2RisksRepo,
  nis2ControlsRepo,
  nis2IncidentsRepo,
  nis2ReportsRepo,
  nis2EvidenceRepo,
  nis2AuditRepo,
  enrollConfig,
  notifyDashboard,
  authRateLimiter,
  enrollRateLimiter,
  logger = silentLogger,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  // Behind a reverse proxy: trust X-Forwarded-* so req.protocol/host reflect the
  // public origin (used to build enrollment URLs). Off by default so clients
  // can't spoof X-Forwarded-* (e.g. into the auth audit log) when the server is
  // exposed directly; set TRUST_PROXY=true when running behind a known proxy.
  app.set('trust proxy', /^(1|true|yes|on)$/i.test(String(process.env.TRUST_PROXY || '').trim()) ? 1 : false);
  // Baseline security headers (no dependency — fits the dependency-free convention).
  // HSTS is intentionally omitted here; it belongs on the TLS-terminating proxy.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' https: data:; connect-src 'self' https: wss:",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger(logger));

  // Static admin dashboard (vanilla HTML/JS). Served before the API router;
  // requests that don't match a file fall through to the JSON API.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Server-wide audit of user actions. Registered before the API router so its
  // res.on('finish') hook sees req.user (set by each route's requireAuth).
  if (auditEventsRepo) app.use(createAuditLogger({ auditRepo: auditEventsRepo, logger }));

  // Application routes. User-JWT RBAC and agent-token auth are enforced inside
  // the individual routers (see src/auth/* and src/routes/*).
  app.use(
    '/',
    createApiRouter({
      db,
      locationsRepo,
      usersRepo,
      agentsRepo,
      auditRepo,
      auditEventsRepo,
      auditLogRepo,
      apiTokensRepo,
      auditLogger,
      enrollmentCodesRepo,
      enrollmentStore,
      agentTokensRepo,
      resultsRepo,
      probeResultsRepo,
      incidentsRepo,
      thresholdsRepo,
      incidentService,
      installToolService,
      licenseManager,
      agentCommander,
      systemInfo,
      findingStore,
      analysisPipeline,
      probePipeline,
      flowPipeline,
      flowsRepo,
      geoTileConfig,
      geoProvider,
      geoipUpdater,
      centroids,
      assistant,
      dispatcher,
      featureGate,
      planService,
      usageService,
      settingsService,
      analysisConfig,
      retentionConfig,
      artifactStore,
      agentSourceStore,
      releaseStore,
      releasePublicKey,
      releaseKeyService,
      testPackagesRepo,
      testPackageRunner,
      speedtestResultsRepo,
      integrationsRepo,
      integrationAuditRepo,
      integrationsDispatcher,
      connectorRegistry,
      secretBox,
      ldapConfigRepo,
      ldapRoleMapRepo,
      ldapLoginAuditRepo,
      ldapAuth,
      ldapAuthEnabledFlag,
      nis2RisksRepo,
      nis2ControlsRepo,
      nis2IncidentsRepo,
      nis2ReportsRepo,
      nis2EvidenceRepo,
      nis2AuditRepo,
      enrollConfig,
      notifyDashboard,
      authRateLimiter,
      enrollRateLimiter,
    })
  );

  // 404 + centralised error handling, always mounted last.
  app.use(notFoundHandler);
  app.use(errorHandler({ logger }));

  return app;
}

module.exports = { createApp };
