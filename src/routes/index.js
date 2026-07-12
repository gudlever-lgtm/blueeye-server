'use strict';

const express = require('express');
const { createHealthRouter } = require('./health');
const { createAuthRouter } = require('./auth');
const { createUsersRouter } = require('./users');
const { createMeRouter } = require('./me');
const { createLocationsRouter } = require('./locations');
const { createAgentsRouter } = require('./agents');
const { createAgentEnrollRouter } = require('./agentEnroll');
const { createAgentReportsRouter } = require('./agentReports');
const { createEnrollmentCodesRouter } = require('./enrollmentCodes');
const { createLicenseRouter } = require('./license');
const { createSystemRouter } = require('./system');
const { createAuditRouter } = require('./audit');
const { createAuditEventsRouter } = require('./auditEvents');
const { createAuditLogRouter } = require('./auditLog');
const { createApiTokensRouter } = require('./apiTokens');
const { createFindingsRouter } = require('./findings');
const { createAssistantRouter } = require('./assistant');
const { createGeoRouter } = require('./geo');
const { createAlertingRouter } = require('./alerting');
const { createExportRouter } = require('./export');
const { createSettingsRouter } = require('./settings');
const { createMapRouter } = require('./map');
const { createGeocodeRouter } = require('./geocode');
const { createFlowsRouter } = require('./flows');
const { createTopologyRouter } = require('./topology');
const { createProbesRouter } = require('./probes');
const { createReportsRouter } = require('./reports');
const { createIncidentsRouter } = require('./incidents');
const { createDeviceConfigRouter } = require('./deviceConfig');
const { createAskCache } = require('../incidentCases/askCache');
const { createThresholdsRouter } = require('./thresholds');
const { createInterfacesRouter } = require('./interfaces');
const { createFleetRouter } = require('./fleet');
const { createDashboardRouter } = require('./dashboard');
const { createForecastRouter } = require('./forecast');
const { createSearchRouter } = require('./search');
const { createEnrollRouter } = require('./enroll');
const { publishSignedReleaseFromSource } = require('../enroll/publishSignedRelease');
const { createEnrollCommandRouter } = require('./enrollCommand');
const { createTestPackagesRouter } = require('./testPackages');
const { createTransactionsRouter } = require('./transactions');
const { createLogsRouter } = require('./logs');
const { createSpeedtestRouter, createSpeedtestReadRouter } = require('./speedtest');
const { createIntegrationsRouter } = require('./integrations');
const { createCmdbSettingsRouter, createCmdbAssetsRouter, createAgentCmdbLinkRouter } = require('./cmdb');
const { createDiagnosticsRouter } = require('./diagnostics');
const { createLdapRouter } = require('./ldap');
const { createOidcAuthRouter, createOidcAdminRouter } = require('./oidc');
const { createSamlAuthRouter, createSamlAdminRouter } = require('./saml');
const { createNis2Router } = require('./nis2');
const { createInvestigationRouter } = require('./investigation');
const { createLocator } = require('../investigation/locator');
const {
  createAgentAuthenticator,
  createAgentTokenMiddleware,
} = require('../auth/agentAuth');
const { createApiTokenMiddleware } = require('../auth/apiTokenAuth');
const { silentLogger } = require('../logger');

// Aggregates the feature routers into a single API router. New resources are
// mounted here, keeping the app factory (src/app.js) small.
function createApiRouter({
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
  enrollmentCodesRepo,
  enrollmentStore,
  agentTokensRepo,
  resultsRepo,
  probeResultsRepo,
  incidentsRepo,
  incidentCasesRepo,
  configSnapshotsRepo,
  thresholdsRepo,
  incidentService,
  installToolService,
  licenseManager,
  agentCommander,
  // Optional { waitMs, pollMs } tuning for POST /agents/:id/reconnect (tests
  // shrink these; production uses the router defaults).
  agentReconnect = {},
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
  agentBinaryStore,
  releaseStore,
  releasePublicKey,
  releaseKeyService,
  testPackagesRepo,
  testPackageRunner,
  transactionsRepo,
  logRing,
  speedtestResultsRepo,
  integrationsRepo,
  integrationAuditRepo,
  integrationsDispatcher,
  connectorRegistry,
  secretBox,
  // CMDB integration (single source of truth): the singleton config + agent↔asset
  // links + its OWN connector registry (ServiceNow / Nautobot / custom).
  cmdbConnectorRegistry,
  cmdbConfigRepo,
  agentCmdbLinksRepo,
  // Injected fetch for the Test area's reachability probes (SAML IdP / AI
  // assistant). Defaults to the global fetch; tests inject a fake so they stay offline.
  diagnosticsFetch,
  // Injected fetch for the server-side geocoding proxy. Tests inject a fake so
  // they stay offline; production uses the global fetch.
  geocodeFetch,
  ldapConfigRepo,
  ldapRoleMapRepo,
  ldapLoginAuditRepo,
  ldapAuth,
  ldapAuthEnabledFlag = false,
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
  enrollConfig = {},
  notifyDashboard,
  // Brute-force throttle for agent enrollment (login has its own loginThrottle).
  // Default undefined → the router falls back to a no-op (tests stay unthrottled).
  enrollRateLimiter,
  // Operational logger, threaded into routers that degrade best-effort (so a
  // swallowed side-effect failure is observable). Defaults to the no-op.
  logger = silentLogger,
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

  // API-token auth (license feature `api_access`): a no-op unless the request
  // carries an API token, in which case it populates req.user so the existing
  // requireAuth/requireRole work unchanged. Mounted once, ahead of every router.
  if (apiTokensRepo) router.use(createApiTokenMiddleware({ apiTokensRepo }));

  router.use('/health', createHealthRouter({ db, tsdb }));
  router.use('/auth', createAuthRouter({ usersRepo, ldapAuth, ldapLoginAuditRepo, auditLogger, oidcAuth, samlAuth }));
  // SSO (OIDC) — public browser flow (login/callback) + admin config/role-map.
  // Licence-gated (sso_oidc) on the admin writes; the login flow itself is gated
  // by oidcAuth.isEnabled() (env flag + licence + configured). Local login stays.
  if (oidcAuth && oidcRoleMapRepo) {
    router.use('/auth/oidc', createOidcAuthRouter({ usersRepo, oidcAuth, ssoLoginAuditRepo, auditLogger }));
    router.use('/api/oidc', createOidcAdminRouter({ oidcAuth, oidcRoleMapRepo, ssoLoginAuditRepo, featureGate }));
  }
  // SSO (SAML 2.0) — public SP-initiated flow (login/ACS/metadata) + admin
  // attribute→role map. Licence-gated (sso_saml) on the admin writes; the login
  // flow is gated by samlAuth.isEnabled(). Local login stays as the fallback.
  if (samlAuth && samlRoleMapRepo) {
    router.use('/auth/saml', createSamlAuthRouter({ usersRepo, samlAuth, ssoLoginAuditRepo, auditLogger }));
    router.use('/api/saml', createSamlAdminRouter({ samlAuth, samlRoleMapRepo, ssoLoginAuditRepo, featureGate }));
  }
  router.use('/users', createUsersRouter({ usersRepo, featureGate, planService, auditLogger }));
  router.use('/me', createMeRouter({ usersRepo }));
  router.use('/locations', createLocationsRouter({ locationsRepo, resultsRepo }));
  router.use('/license', createLicenseRouter({ licenseManager, featureGate, planService, usageService, auditLogger }));
  router.use('/system', createSystemRouter({ systemInfo, agentSourceStore, agentBinaryStore, releaseStore }));
  if (findingStore) router.use('/api/findings', createFindingsRouter({ findingStore }));
  if (assistant) router.use('/api/assistant', createAssistantRouter({ assistant, featureGate }));
  if (flowsRepo) router.use('/api/geo', createGeoRouter({ flowsRepo, agentsRepo, findingStore, tileConfig: geoTileConfig, getMapConfig, geoProvider, featureGate }));
  if (dispatcher) router.use('/api/alerting', createAlertingRouter({ dispatcher }));
  router.use('/api/map', createMapRouter({ getMapConfig }));
  // Server-side geocoding proxy: the geocodeUrl stays server-side so
  // private-network (self-hosted/EU) geocoders work without browser network access.
  router.use('/api/geocode', createGeocodeRouter({
    getGeocodeUrl: settingsService ? () => settingsService.getMap().then((m) => m.geocodeUrl || '') : null,
    fetchImpl: geocodeFetch,
  }));
  router.use('/api/flows', createFlowsRouter({
    resultsRepo, agentsRepo, flowsRepo,
    getCategories: settingsService ? () => settingsService.getFlowCategories() : undefined,
  }));
  // Flow-derived dependency/topology map (who-talks-to-whom from the 5-tuples).
  if (flowsRepo) router.use('/api/topology', createTopologyRouter({ flowsRepo, agentsRepo, locationsRepo, centroids }));
  if (probeResultsRepo) router.use('/api/probes', createProbesRouter({ probeResultsRepo, agentsRepo, geoProvider, centroids }));
  if (probeResultsRepo) router.use('/api/fleet', createFleetRouter({ agentsRepo, probeResultsRepo, resultsRepo, speedtestResultsRepo, settingsService, logger }));
  // Overview "open issues" rollup (license feature `dashboard_advanced`,
  // Professional+) — active incidents + recent findings, gated. Surfaced inline
  // on the Overview page; fleet health itself comes from /api/fleet above.
  router.use('/api/dashboard', createDashboardRouter({ incidentsRepo, incidentCasesRepo, findingStore, featureGate, planService }));
  if (incidentsRepo && probeResultsRepo) router.use('/api/reports', createReportsRouter({ probeResultsRepo, incidentsRepo, locationsRepo, featureGate, planService, auditLogger }));
  // First-class incidents (incident_cases) wrapping findings — distinct from the
  // probe-outage `incidents` used by /api/reports above.
  if (incidentCasesRepo && findingStore) router.use('/api/incidents', createIncidentsRouter({ incidentCasesRepo, findingStore, auditLogger, auditEventsRepo, auditLogRepo, configSnapshotsRepo, agentsRepo, assistant, featureGate, askCache: createAskCache() }));
  // Device config history (operator/admin, masked) — Fase 3.
  if (configSnapshotsRepo) router.use('/api/devices', createDeviceConfigRouter({ configSnapshotsRepo, agentsRepo, auditLogger }));
  if (thresholdsRepo) router.use('/api/thresholds', createThresholdsRouter({ thresholdsRepo, locationsRepo }));
  router.use('/api/interfaces', createInterfacesRouter({ resultsRepo, agentsRepo }));
  // Capacity/trend forecasting (robust Theil–Sen projection + days-to-capacity).
  router.use('/api/forecast', createForecastRouter());
  router.use('/api/search', createSearchRouter({ agentsRepo, locationsRepo, flowsRepo }));
  if (settingsService) router.use('/api/settings', createSettingsRouter({ settingsService, featureGate, dispatcher, analysisConfig, retentionConfig, releaseKeyService, geoipUpdater, publishRelease: () => publishSignedReleaseFromSource({ sourceStore: agentSourceStore, releaseStore, releaseKeyService }) }));
  // Outbound API integrations (ITSM/IPAM connectors) — admin CRUD + test-fire.
  if (integrationsRepo && connectorRegistry && secretBox) {
    router.use('/api/integrations', createIntegrationsRouter({
      integrationsRepo, integrationAuditRepo, dispatcher: integrationsDispatcher, registry: connectorRegistry, secretBox,
    }));
  }
  // CMDB integration (single source of truth) — admin config + connection test,
  // operator+ asset search, and per-agent asset links. Reuses the connector
  // registry + secretBox that the integrations feature already wires.
  if (cmdbConfigRepo && cmdbConnectorRegistry && secretBox) {
    router.use('/api/settings/cmdb', createCmdbSettingsRouter({ cmdbConfigRepo, registry: cmdbConnectorRegistry, secretBox }));
    router.use('/api/cmdb/assets', createCmdbAssetsRouter({ cmdbConfigRepo, registry: cmdbConnectorRegistry, secretBox }));
  }
  if (agentCmdbLinksRepo) {
    router.use('/api/agents', createAgentCmdbLinkRouter({ agentCmdbLinksRepo, agentsRepo, locationsRepo }));
  }
  // Test area — consolidated, admin-only security screening of every outbound
  // integration (email/alert channels, ITSM/IPAM receivers, SSO, AI/map/licence).
  // Reuses each subsystem's own test primitive; adds a security-posture lens.
  router.use('/api/diagnostics', createDiagnosticsRouter({
    alertingDispatcher: dispatcher,
    integrationsRepo,
    integrationsDispatcher,
    cmdbConfigRepo,
    connectorRegistry: cmdbConnectorRegistry,
    secretBox,
    ldapAuth,
    ldapConfigRepo,
    oidcAuth,
    samlAuth,
    assistant,
    settingsService,
    licenseManager,
    featureGate,
    fetchImpl: diagnosticsFetch,
  }));
  // External auth (LDAP/AD) config — admin CRUD + connectivity test + login audit.
  // Licence-gated (sso_ldap) on the writes via the shared featureGate.
  if (ldapConfigRepo && ldapRoleMapRepo && secretBox) {
    router.use('/api/ldap', createLdapRouter({
      ldapConfigRepo, ldapRoleMapRepo, ldapLoginAuditRepo, ldapAuth, secretBox, featureGate, authEnabledFlag: ldapAuthEnabledFlag,
    }));
  }
  // NIS2 Reporting Center — risk register, control evidence, security incidents,
  // management reports, evidence references + audit trail. Self-contained module.
  if (nis2RisksRepo && nis2ControlsRepo && nis2IncidentsRepo) {
    router.use('/api/nis2', createNis2Router({
      nis2RisksRepo, nis2ControlsRepo, nis2IncidentsRepo,
      nis2ReportsRepo, nis2EvidenceRepo, nis2AuditRepo,
      featureGate, planService, releaseKeyService,
    }));
  }
  // Lokationsdrevet investigation — trigger en rutine der samler og korrelerer
  // anomali-/counter-data for et givet sted og klassificerer fejlen.
  if (investigationsRepo && agentsRepo && findingStore) {
    const locator = createLocator({ agentsRepo, findingStore, locationsRepo, flowsRepo: flowsRepo || null });
    router.use('/api/investigation', createInvestigationRouter({
      investigationsRepo,
      locator,
      assistant: assistant || null,
      incidentsRepo: incidentsRepo || null,
      nis2IncidentsRepo: nis2IncidentsRepo || null,
      logger,
    }));
  }
  if (testPackagesRepo) router.use('/api/test-packages', createTestPackagesRouter({ repo: testPackagesRepo, runner: testPackageRunner, usageService }));
  if (transactionsRepo) {
    router.use('/api/transactions', createTransactionsRouter({
      repo: transactionsRepo,
      // Config-push hook: notify affected agents over WS when tests/assignments
      // change. Late-bound via agentCommander (the WS server starts after the app).
      pushConfig: agentCommander ? agentCommander.pushTransactionConfig : null,
    }));
  }
  if (logRing) router.use('/api/logs', createLogsRouter({ logRing }));
  if (speedtestResultsRepo) {
    router.use('/speedtest', createSpeedtestRouter({ agentAuth, speedtestResultsRepo }));
    router.use('/api/speedtest', createSpeedtestReadRouter({ speedtestResultsRepo, agentsRepo }));
  }
  router.use('/api/export', createExportRouter({ findingStore, flowsRepo, agentsRepo, locationsRepo, resultsRepo, probeResultsRepo, featureGate }));
  router.use('/enrollment-codes', createEnrollmentCodesRouter({ enrollmentCodesRepo, locationsRepo }));

  // Frictionless enrollment. Public (unauthenticated) source + install-script
  // endpoints under /enroll; the authenticated command generator under /api.
  if (artifactStore || agentSourceStore || releaseStore) {
    router.use('/enroll', createEnrollRouter({ artifactStore, sourceStore: agentSourceStore, binaryStore: agentBinaryStore, releaseStore, releasePublicKey, enrollmentCodesRepo, enrollConfig }));
    router.use('/api/enroll', createEnrollCommandRouter({ enrollmentCodesRepo, artifactStore, sourceStore: agentSourceStore, enrollConfig, releaseKeyService, defaultTtlMinutes: enrollConfig.defaultTtlMinutes }));
  }

  // Three routers share the /agents prefix, each with its own auth model:
  //   - CRUD + results listing — user JWT (RBAC)
  //   - POST /results          — agent token
  //   - POST /enroll           — unauthenticated
  // Requests fall through routers that have no matching route.
  router.use('/agents', createAgentsRouter({ agentsRepo, locationsRepo, resultsRepo, agentCommander, agentSourceStore, releaseStore, releasePublicKey, auditRepo, integrationTrigger: integrationsDispatcher, logger, reconnect: agentReconnect }));
  router.use('/audit', createAuditRouter({ auditRepo }));
  // Unified, server-wide audit trail (Reporting → Audit) — admin only.
  if (auditEventsRepo) router.use('/api/audit', createAuditEventsRouter({ auditEventsRepo, auditLogRepo, featureGate }));
  // Unified audit log (license feature `audit_log`) + API tokens (`api_access`).
  if (auditLogRepo) router.use('/api/audit-log', createAuditLogRouter({ auditLogRepo, featureGate, planService }));
  if (apiTokensRepo) router.use('/api/api-tokens', createApiTokensRouter({ apiTokensRepo, featureGate, planService, auditLogger }));
  router.use('/agents', createAgentReportsRouter({ agentAuth, resultsRepo, resultsTsdbRepo, agentsRepo, auditEventsRepo, analysisPipeline, flowPipeline, probeResultsRepo, probePipeline, incidentService, installToolService, logger }));
  router.use('/agents', createAgentEnrollRouter({ enrollmentStore, notifyDashboard, integrationTrigger: integrationsDispatcher, auditEventsRepo, settingsService, rateLimit: enrollRateLimiter }));

  return router;
}

module.exports = { createApiRouter };
