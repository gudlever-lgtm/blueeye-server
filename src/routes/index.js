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
const { createFlowsRouter } = require('./flows');
const { createProbesRouter } = require('./probes');
const { createReportsRouter } = require('./reports');
const { createThresholdsRouter } = require('./thresholds');
const { createInterfacesRouter } = require('./interfaces');
const { createFleetRouter } = require('./fleet');
const { createDashboardRouter } = require('./dashboard');
const { createSearchRouter } = require('./search');
const { createEnrollRouter } = require('./enroll');
const { publishSignedReleaseFromSource } = require('../enroll/publishSignedRelease');
const { createEnrollCommandRouter } = require('./enrollCommand');
const { createTestPackagesRouter } = require('./testPackages');
const { createSpeedtestRouter, createSpeedtestReadRouter } = require('./speedtest');
const { createIntegrationsRouter } = require('./integrations');
const { createLdapRouter } = require('./ldap');
const { createOidcAuthRouter, createOidcAdminRouter } = require('./oidc');
const { createSamlAuthRouter, createSamlAdminRouter } = require('./saml');
const { createNis2Router } = require('./nis2');
const {
  createAgentAuthenticator,
  createAgentTokenMiddleware,
} = require('../auth/agentAuth');
const { createApiTokenMiddleware } = require('../auth/apiTokenAuth');

// Aggregates the feature routers into a single API router. New resources are
// mounted here, keeping the app factory (src/app.js) small.
function createApiRouter({
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

  // API-token auth (license feature `api_access`): a no-op unless the request
  // carries an API token, in which case it populates req.user so the existing
  // requireAuth/requireRole work unchanged. Mounted once, ahead of every router.
  if (apiTokensRepo) router.use(createApiTokenMiddleware({ apiTokensRepo }));

  router.use('/health', createHealthRouter({ db }));
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
  router.use('/system', createSystemRouter({ systemInfo, agentSourceStore, releaseStore }));
  if (findingStore) router.use('/api/findings', createFindingsRouter({ findingStore }));
  if (assistant) router.use('/api/assistant', createAssistantRouter({ assistant, featureGate }));
  if (flowsRepo) router.use('/api/geo', createGeoRouter({ flowsRepo, agentsRepo, findingStore, tileConfig: geoTileConfig, getMapConfig, geoProvider, featureGate }));
  if (dispatcher) router.use('/api/alerting', createAlertingRouter({ dispatcher }));
  router.use('/api/map', createMapRouter({ getMapConfig }));
  router.use('/api/flows', createFlowsRouter({
    resultsRepo, agentsRepo, flowsRepo,
    getCategories: settingsService ? () => settingsService.getFlowCategories() : undefined,
  }));
  if (probeResultsRepo) router.use('/api/probes', createProbesRouter({ probeResultsRepo, agentsRepo, geoProvider, centroids }));
  if (probeResultsRepo) router.use('/api/fleet', createFleetRouter({ agentsRepo, probeResultsRepo, resultsRepo, speedtestResultsRepo, settingsService }));
  // Advanced dashboard (license feature `dashboard_advanced`, Professional+) —
  // drill-down widget panels composed from fleet/incident/finding data, gated.
  if (probeResultsRepo) router.use('/api/dashboard', createDashboardRouter({ agentsRepo, probeResultsRepo, incidentsRepo, findingStore, featureGate, planService }));
  if (incidentsRepo && probeResultsRepo) router.use('/api/reports', createReportsRouter({ probeResultsRepo, incidentsRepo, locationsRepo, featureGate, planService, auditLogger }));
  if (thresholdsRepo) router.use('/api/thresholds', createThresholdsRouter({ thresholdsRepo, locationsRepo }));
  router.use('/api/interfaces', createInterfacesRouter({ resultsRepo, agentsRepo }));
  router.use('/api/search', createSearchRouter({ agentsRepo, locationsRepo, flowsRepo }));
  if (settingsService) router.use('/api/settings', createSettingsRouter({ settingsService, featureGate, dispatcher, analysisConfig, retentionConfig, releaseKeyService, geoipUpdater, publishRelease: () => publishSignedReleaseFromSource({ sourceStore: agentSourceStore, releaseStore, releaseKeyService }) }));
  // Outbound API integrations (ITSM/IPAM connectors) — admin CRUD + test-fire.
  if (integrationsRepo && connectorRegistry && secretBox) {
    router.use('/api/integrations', createIntegrationsRouter({
      integrationsRepo, integrationAuditRepo, dispatcher: integrationsDispatcher, registry: connectorRegistry, secretBox,
    }));
  }
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
      featureGate, planService,
    }));
  }
  if (testPackagesRepo) router.use('/api/test-packages', createTestPackagesRouter({ repo: testPackagesRepo, runner: testPackageRunner, usageService }));
  if (speedtestResultsRepo) {
    router.use('/speedtest', createSpeedtestRouter({ agentAuth, speedtestResultsRepo }));
    router.use('/api/speedtest', createSpeedtestReadRouter({ speedtestResultsRepo, agentsRepo }));
  }
  router.use('/api/export', createExportRouter({ findingStore, flowsRepo, agentsRepo, locationsRepo, resultsRepo, probeResultsRepo, featureGate }));
  router.use('/enrollment-codes', createEnrollmentCodesRouter({ enrollmentCodesRepo, locationsRepo }));

  // Frictionless enrollment. Public (unauthenticated) source + install-script
  // endpoints under /enroll; the authenticated command generator under /api.
  if (artifactStore || agentSourceStore || releaseStore) {
    router.use('/enroll', createEnrollRouter({ artifactStore, sourceStore: agentSourceStore, releaseStore, releasePublicKey, enrollmentCodesRepo, enrollConfig }));
    router.use('/api/enroll', createEnrollCommandRouter({ enrollmentCodesRepo, artifactStore, sourceStore: agentSourceStore, enrollConfig, releaseKeyService }));
  }

  // Three routers share the /agents prefix, each with its own auth model:
  //   - CRUD + results listing — user JWT (RBAC)
  //   - POST /results          — agent token
  //   - POST /enroll           — unauthenticated
  // Requests fall through routers that have no matching route.
  router.use('/agents', createAgentsRouter({ agentsRepo, locationsRepo, resultsRepo, agentCommander, agentSourceStore, releaseStore, releasePublicKey, auditRepo, integrationTrigger: integrationsDispatcher }));
  router.use('/audit', createAuditRouter({ auditRepo }));
  // Unified, server-wide audit trail (Reporting → Audit) — admin only.
  if (auditEventsRepo) router.use('/api/audit', createAuditEventsRouter({ auditEventsRepo }));
  // Unified audit log (license feature `audit_log`) + API tokens (`api_access`).
  if (auditLogRepo) router.use('/api/audit-log', createAuditLogRouter({ auditLogRepo, featureGate, planService }));
  if (apiTokensRepo) router.use('/api/api-tokens', createApiTokensRouter({ apiTokensRepo, featureGate, planService, auditLogger }));
  router.use('/agents', createAgentReportsRouter({ agentAuth, resultsRepo, agentsRepo, auditEventsRepo, analysisPipeline, flowPipeline, probeResultsRepo, probePipeline, incidentService, installToolService }));
  router.use('/agents', createAgentEnrollRouter({ enrollmentStore, notifyDashboard, integrationTrigger: integrationsDispatcher }));

  return router;
}

module.exports = { createApiRouter };
