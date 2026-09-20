'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { version: appVersion } = require('../package.json');
const { createApiRouter } = require('./routes');
const { requestLogger } = require('./middleware/requestLogger');
const { securityHeaders } = require('./middleware/securityHeaders');
const { createAuditLogger } = require('./middleware/auditLogger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
// The view ↔ path map the dashboard and the server share (see public/routes.js).
const appRoutes = require('../public/routes.js');
const { silentLogger } = require('./logger');

// Builds the Express application. Dependencies (db + repositories + logger) are
// injected so the same factory powers both the real server and the test suite.
// It deliberately does NOT call listen() — that belongs to src/server.js.
function createApp({
  db,
  tsdb = null,
  resultsTsdbRepo = null,
  locationsRepo,
  usersRepo,
  agentsRepo,
  auditRepo,
  auditEventsRepo,
  auditLogRepo,
  apiTokensRepo,
  auditLogger,
  userMailer,
  enrollmentCodesRepo,
  enrollmentStore,
  agentTokensRepo,
  resultsRepo,
  probeResultsRepo,
  diagnoseSessionsRepo = null,
  probeOutagesRepo,
  reportSchedulesRepo,
  reportScheduler,
  eventCasesRepo,
  eventNotesRepo,
  eventClustersRepo,
  clusterNotifier,
  alertDispatchLogRepo,
  evidenceRepo,
  snapshotService,
  runbooksRepo,
  verificationRunsRepo,
  verificationService,
  remediationPlaybooksRepo,
  configSnapshotsRepo,
  thresholdsRepo,
  probeOutageService,
  installToolService,
  commandSigner,
  licenseManager,
  agentCommander,
  agentReconnect = {},
  systemInfo,
  findingStore,
  severityRulesRepo = null,
  analysisPipeline,
  probePipeline,
  flowPipeline,
  flowsRepo,
  lldpNeighborsRepo,
  serviceDependenciesRepo,
  hostConnectionsRepo,
  arpEntriesRepo,
  deviceEventsRepo,
  deviceEventIngest,
  snmpDevicesRepo,
  snmpNeighborsRepo,
  fdbEntriesRepo,
  snmpTopologyIngest,
  deviceInterfacesRepo,
  burstRunsRepo,
  burstService,
  interfaceStatesRepo,
  interfaceStateService,
  serviceDependencyJob,
  blastRadiusService,
  topologyChangesRepo,
  topologyChangeService,
  flowPairBaselinesRepo,
  flowPairBaselineJob,
  discoveredDevicesRepo,
  discoverySweepJob,
  discoveryConfig,
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
  agentBinaryStore,
  releaseStore,
  releasePublicKey,
  releaseKeyService,
  // Runs the host's update script from Settings → Updates (opt-in; null unless
  // SERVER_UPDATE_COMMAND is configured).
  serverUpdateService = null,
  testPackagesRepo,
  testPackageRunner,
  transactionsRepo,
  // Service Assurance — the assembled module (src/serviceTests/index.js).
  serviceTests = null,
  speedtestResultsRepo,
  integrationsRepo,
  integrationAuditRepo,
  integrationsDispatcher,
  connectorRegistry,
  cmdbConnectorRegistry,
  secretBox,
  cmdbConfigRepo,
  agentCmdbLinksRepo,
  diagnosticsFetch,
  geocodeFetch,
  ldapConfigRepo,
  ldapRoleMapRepo,
  ldapLoginAuditRepo,
  ldapAuth,
  ldapAuthEnabledFlag,
  oidcAuth,
  oidcRoleMapRepo,
  samlAuth,
  samlRoleMapRepo,
  ssoLoginAuditRepo,
  nis2RisksRepo,
  nis2ControlsRepo,
  nis2IncidentsRepo,
  nis2ReportsRepo,
  nis2EvidenceRepo,
  nis2AuditRepo,
  investigationsRepo,
  enrollConfig,
  notifyDashboard,
  enrollRateLimiter,
  logger = silentLogger,
  // In-memory operational log ring buffer, surfaced admin-only in the Logs view.
  logRing = null,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  // Behind a reverse proxy: trust X-Forwarded-* so req.protocol/host reflect the
  // public origin (used to build enrollment URLs). Off by default so clients
  // can't spoof X-Forwarded-* (e.g. into the auth audit log) when the server is
  // exposed directly; set TRUST_PROXY=true when running behind a known proxy.
  app.set('trust proxy', /^(1|true|yes|on)$/i.test(String(process.env.TRUST_PROXY || '').trim()) ? 1 : false);
  // Always-on baseline security headers (HSTS/CSP/X-Frame-Options/nosniff/
  // Referrer-Policy) on EVERY response — static dashboard + API alike. Mounted
  // first, before the static handler, and not behind any feature key.
  app.use(securityHeaders());
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger(logger));

  // Version-stamp the dashboard entry point so a server upgrade forces browsers
  // to re-fetch app.js/styles.css. Without this, index.html loads `/app.js` with
  // no query string; a client holding a cached copy keeps calling retired
  // endpoints after an upgrade (e.g. the old /api/transaction-tests → 404). We
  // rewrite the local <script>/<link> src to `?v=<version>` — a new URL per
  // release busts the cache; API/data storage are untouched. Built once at
  // startup (version is constant per process); on any read error we fall through
  // to the raw static file so the dashboard still loads.
  let stampedIndexHtml = null;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    stampedIndexHtml = raw
      .replace('src="/app.js"', `src="/app.js?v=${appVersion}"`)
      .replace('href="/styles.css"', `href="/styles.css?v=${appVersion}"`)
      .replace('href="/css/tokens.css"', `href="/css/tokens.css?v=${appVersion}"`)
      .replace('href="/css/base.css"', `href="/css/base.css?v=${appVersion}"`)
      .replace('href="/css/components.css"', `href="/css/components.css?v=${appVersion}"`);
  } catch (err) {
    logger.warn({ err }, 'could not read index.html for version stamping; serving raw');
  }

  // A browser NAVIGATION wants the dashboard shell; an XHR wants JSON. The two
  // collide because several screens share a path with an API route (/agents is
  // both a page and GET /agents). Sec-Fetch-Dest: document is the browser's own
  // word for "this is a navigation"; the Accept header covers clients that do
  // not send it. app.js's api() sends neither, so a fetch never matches.
  const isDocumentRequest = (req) => req.method === 'GET'
    && (req.get('sec-fetch-dest') === 'document'
      || String(req.get('accept') || '').includes('text/html'));
  const sendShell = (res, status) => res.status(status).type('html').send(stampedIndexHtml);

  if (stampedIndexHtml) {
    // The entry point. '/' and '/index.html' collide with nothing, so they are
    // served to every client, Accept header or not.
    app.get(['/', '/index.html'], (req, res) => sendShell(res, 200));
    // Every other address inside the dashboard's namespace, served BEFORE the
    // API router so a navigation to /agents gets the dashboard rather than the
    // agents JSON. An address the map owns but cannot resolve (/agents/abc) is
    // the same shell with a 404: a mistyped page address deserves the page that
    // says so, not an API error the person cannot read.
    app.use((req, res, next) => {
      if (!isDocumentRequest(req) || !appRoutes.ownsPath(req.path)) return next();
      return sendShell(res, appRoutes.isAppPath(req.path) ? 200 : 404);
    });
  }

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
      tsdb,
      resultsTsdbRepo,
      locationsRepo,
      usersRepo,
      agentsRepo,
      auditRepo,
      auditEventsRepo,
      auditLogRepo,
      apiTokensRepo,
      auditLogger,
      userMailer,
      enrollmentCodesRepo,
      enrollmentStore,
      agentTokensRepo,
      resultsRepo,
      probeResultsRepo,
      diagnoseSessionsRepo,
      probeOutagesRepo,
      reportSchedulesRepo,
      reportScheduler,
      eventCasesRepo,
      eventNotesRepo,
      eventClustersRepo,
      clusterNotifier,
      alertDispatchLogRepo,
      evidenceRepo,
      snapshotService,
      runbooksRepo,
      verificationRunsRepo,
      verificationService,
      remediationPlaybooksRepo,
      configSnapshotsRepo,
      thresholdsRepo,
      probeOutageService,
      installToolService,
      commandSigner,
      licenseManager,
      agentCommander,
      agentReconnect,
      systemInfo,
      findingStore,
      severityRulesRepo,
      analysisPipeline,
      probePipeline,
      flowPipeline,
      flowsRepo,
  lldpNeighborsRepo,
      serviceDependenciesRepo,
      hostConnectionsRepo,
      arpEntriesRepo,
      deviceEventsRepo,
      deviceEventIngest,
      snmpDevicesRepo,
      snmpNeighborsRepo,
      fdbEntriesRepo,
      snmpTopologyIngest,
      deviceInterfacesRepo,
      burstRunsRepo,
      burstService,
      interfaceStatesRepo,
      interfaceStateService,
      serviceDependencyJob,
      blastRadiusService,
      topologyChangesRepo,
      topologyChangeService,
      flowPairBaselinesRepo,
      flowPairBaselineJob,
      discoveredDevicesRepo,
      discoverySweepJob,
      discoveryConfig,
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
      agentBinaryStore,
      releaseStore,
      releasePublicKey,
      releaseKeyService,
      serverUpdateService,
      testPackagesRepo,
      testPackageRunner,
      transactionsRepo,
      serviceTests,
      speedtestResultsRepo,
      integrationsRepo,
      integrationAuditRepo,
      integrationsDispatcher,
      connectorRegistry,
      cmdbConnectorRegistry,
      secretBox,
      cmdbConfigRepo,
      agentCmdbLinksRepo,
      diagnosticsFetch,
      geocodeFetch,
      ldapConfigRepo,
      ldapRoleMapRepo,
      ldapLoginAuditRepo,
      ldapAuth,
      ldapAuthEnabledFlag,
      oidcAuth,
      oidcRoleMapRepo,
      samlAuth,
      samlRoleMapRepo,
      ssoLoginAuditRepo,
      nis2RisksRepo,
      nis2ControlsRepo,
      nis2IncidentsRepo,
      nis2ReportsRepo,
      nis2EvidenceRepo,
      nis2AuditRepo,
      investigationsRepo,
      enrollConfig,
      notifyDashboard,
      enrollRateLimiter,
      logger,
      logRing,
    })
  );

  // An unknown address that a BROWSER asked for is a page that does not exist,
  // not a missing API endpoint: answer 404 with the same shell so the user keeps
  // the sidebar, the topbar and a way out. Mounted after the API router, so
  // anything the API serves as HTML (the NIS2 documents, the report exports) has
  // already answered by the time we get here.
  if (stampedIndexHtml) {
    app.use((req, res, next) => {
      if (!isDocumentRequest(req)) return next();
      return sendShell(res, 404);
    });
  }

  // 404 + centralised error handling, always mounted last.
  app.use(notFoundHandler);
  app.use(errorHandler({ logger }));

  return app;
}

module.exports = { createApp };
