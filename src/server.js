'use strict';

const { config } = require('./config');
const { createLogger, createLogRing } = require('./logger');
const { createRateLimiter } = require('./middleware/rateLimit');
const { createRevocationRegistry } = require('./auth/revocation');
const { setRevocationCheck } = require('./auth/middleware');
const { createDb } = require('./db');
const { createTsdb } = require('./tsdb');
const { createResultsTsdbRepository } = require('./repositories/resultsTsdbRepository');
const { createApp } = require('./app');
const { createLocationsRepository } = require('./repositories/locationsRepository');
const { createUsersRepository } = require('./repositories/usersRepository');
const { createAgentsRepository } = require('./repositories/agentsRepository');
const { createAgentActionAuditRepository } = require('./repositories/agentActionAuditRepository');
const { createAuditEventsRepository } = require('./repositories/auditEventsRepository');
const { createAuditLogRepository } = require('./repositories/auditLogRepository');
const { createApiTokensRepository } = require('./repositories/apiTokensRepository');
const { createAuditLogger } = require('./services/complianceLogger');
const { createEnrollmentCodesRepository } = require('./repositories/enrollmentCodesRepository');
const { createEnrollmentStore } = require('./services/enrollmentStore');
const { createAgentTokensRepository } = require('./repositories/agentTokensRepository');
const { createResultsRepository } = require('./repositories/resultsRepository');
const { createProbeResultsRepository } = require('./repositories/probeResultsRepository');
const { createIncidentsRepository } = require('./repositories/incidentsRepository');
const { createIncidentThresholdsRepository } = require('./repositories/incidentThresholdsRepository');
const { createIncidentService } = require('./incidents/incidentService');
const { createInstallToolService } = require('./services/installToolService');
const { createArtifactStore } = require('./enroll/artifactStore');
const { createAgentSourceStore } = require('./enroll/agentSourceStore');
const { createAgentBinaryStore } = require('./enroll/agentBinaryStore');
const { createAgentReleaseStore } = require('./enroll/agentReleaseStore');
const { createAgentReleaseKeyRepository } = require('./repositories/agentReleaseKeyRepository');
const { createReleaseKeyService } = require('./enroll/releaseKeyService');
const { publishSignedReleaseFromSource } = require('./enroll/publishSignedRelease');
const { attachAgentWebSocket } = require('./ws/agentSocket');
const { attachDashboardWebSocket } = require('./ws/dashboardSocket');
const { verifyToken } = require('./auth/jwt');
const { createLicenseManager } = require('./license/licenseManager');
const { createFeatureGate } = require('./license/features');
const { createPlanService } = require('./license/planService');
const { createUsageService } = require('./services/usageService');
const { createFileCache } = require('./license/licenseCache');
const { isConfigured } = require('./license/publicKey');
const { createSystemInfo } = require('./services/systemInfo');
const { FindingStore } = require('./analysis/findings');
const { createBaselineStore } = require('./analysis/baselines');
const { createBaselineFileCache } = require('./analysis/baselineCache');
const { createDetector } = require('./analysis/detector');
const { createAnalysisPipeline } = require('./analysis/pipeline');
const { createProbePipeline } = require('./analysis/probePipeline');
const { createCorrelator } = require('./analysis/correlator');
const { createIncidentCasesRepository } = require('./repositories/incidentCasesRepository');
const { createConfigSnapshotsRepository } = require('./repositories/configSnapshotsRepository');
const { createIncidentCaseService } = require('./incidentCases/incidentCaseService');
const { createIncidentAutoResolveJob } = require('./incidentCases/autoResolveJob');
const { createAssistant } = require('./analysis/assistant');
const { loadConfig: loadAnalysisConfig } = require('./analysis/config');
const { createFlowsRepository } = require('./repositories/flowsRepository');
const { createGeoProvider } = require('./geo/provider');
const { createGeoipUpdater } = require('./geo/geoipUpdater');
const { createCentroids } = require('./geo/centroids');
const { createGeoEnricher } = require('./geo/enricher');
const { createFlowPipeline } = require('./geo/flowPipeline');
const { loadAlertingConfig } = require('./analysis/alerting/config');
const { createDispatcher } = require('./analysis/alerting/dispatcher');
const { createSilencer } = require('./analysis/alerting/maintenance');
const { createEmailChannel, createSmtpTransport } = require('./analysis/alerting/channels/email');
const { createWebhookChannel } = require('./analysis/alerting/channels/webhook');
const { createSyslogChannel } = require('./analysis/alerting/channels/syslog');
const { loadRetentionConfig } = require('./analysis/retention/config');
const { createRetentionRepo } = require('./analysis/retention/repo');
const { createRollup } = require('./analysis/retention/rollup');
const { createPurge } = require('./analysis/retention/purge');
const { createRetentionScheduler } = require('./analysis/retention/scheduler');
const { createSettingsRepository } = require('./repositories/settingsRepository');
const { createSettingsService } = require('./services/settings');
const { createTestPackagesRepository } = require('./repositories/testPackagesRepository');
const { createTransactionsRepository } = require('./repositories/transactionsRepository');
const { createTransactionBaselineJob } = require('./analysis/transactionBaselines');
const { createTestPackageRunner } = require('./services/testPackageRunner');
const { createTestPackageScheduler } = require('./services/testPackageScheduler');
const { createSpeedtestResultsRepository } = require('./repositories/speedtestResultsRepository');
const { createSecretBox } = require('./lib/secretBox');
const { createIntegrationsRepository } = require('./repositories/integrationsRepository');
const { createIntegrationAuditRepository } = require('./repositories/integrationAuditRepository');
const { createCmdbConfigRepository } = require('./repositories/cmdbConfigRepository');
const { createAgentCmdbLinksRepository } = require('./repositories/agentCmdbLinksRepository');
const { createConnectorRegistry } = require('./integrations/connectors');
const { createIntegrationsDispatcher } = require('./integrations/dispatcher');
const { createLdapConfigRepository } = require('./repositories/ldapConfigRepository');
const { createLdapRoleMapRepository } = require('./repositories/ldapRoleMapRepository');
const { createLdapLoginAuditRepository } = require('./repositories/ldapLoginAuditRepository');
const { createLdapAuth } = require('./auth/ldap');
const { createOidcRoleMapRepository } = require('./repositories/oidcRoleMapRepository');
const { createSamlRoleMapRepository } = require('./repositories/samlRoleMapRepository');
const { createSsoLoginAuditRepository } = require('./repositories/ssoLoginAuditRepository');
const { createOidcAuth } = require('./auth/oidc');
const { createSamlAuth } = require('./auth/saml');
const { createNis2RisksRepository } = require('./repositories/nis2RisksRepository');
const { createNis2ControlsRepository } = require('./repositories/nis2ControlsRepository');
const { createNis2IncidentsRepository } = require('./repositories/nis2IncidentsRepository');
const { createNis2ReportsRepository } = require('./repositories/nis2ReportsRepository');
const { createNis2EvidenceRepository } = require('./repositories/nis2EvidenceRepository');
const { createNis2AuditRepository } = require('./repositories/nis2AuditRepository');
const { createInvestigationsRepository } = require('./repositories/investigationsRepository');
const { version: appVersion } = require('../package.json');

// Wires up real dependencies, starts the HTTP server and installs graceful
// shutdown handlers.
function start() {
  // Operational logger (LOG_LEVEL, LOG_FORMAT=json). Injected into every module
  // below in place of bare console, so all diagnostics share one leveled,
  // timestamped, optionally-JSON stream.
  // In-memory ring buffer of recent log records, surfaced admin-only in the
  // dashboard Logs view. The logger mirrors every record into it; stdout/stderr
  // output is unchanged.
  const logRing = createLogRing({ capacity: Number(process.env.LOG_BUFFER_SIZE) || 1000 });
  const logger = createLogger({ onRecord: logRing.record });

  // Never run in production with a weak JWT secret: the built-in development
  // default, a known docker-compose example fallback, or anything too short.
  // SECRET_ENCRYPTION_KEY falls back to JWT_SECRET, so this also guards secrets
  // at rest.
  if (config.env === 'production' && config.auth.weakSecret) {
    logger.error(
      'Refusing to start: JWT_SECRET must be a strong, unique value in production ' +
        '(not a known default, at least 32 characters).'
    );
    process.exit(1);
  }

  // License trust anchor: in production, LICENSE_PUBLIC_KEY is only honoured
  // alongside TRUST_ANCHOR_OVERRIDE_ACK (see src/license/trustAnchorGuard.js) —
  // otherwise the same operator the license is meant to constrain could point
  // verification at a public key of their own and self-sign an unlimited
  // license. Neither case is fatal (the server always boots), but both are
  // loud: a blocked override usually means the operator forgot the embedded
  // key belongs in src/license/publicKey.js, not .env.
  if (config.license.publicKeySource === 'blocked') {
    logger.warn(
      'License: LICENSE_PUBLIC_KEY is set but ignored in production (no ' +
        'TRUST_ANCHOR_OVERRIDE_ACK) — verifying against the embedded key in ' +
        'src/license/publicKey.js instead. Set the real key there for production installs.'
    );
  } else if (config.license.publicKeySource === 'env' && config.env === 'production') {
    logger.warn(
      'License: verifying against LICENSE_PUBLIC_KEY from the environment ' +
        '(TRUST_ANCHOR_OVERRIDE_ACK set) instead of the embedded key — only ' +
        'expected for a demo/test install.'
    );
  }

  // Log how this server identifies itself to blueeye-licens. When derived (no
  // LICENSE_SERVER_ID set), the id is stable per host and licens binds the
  // license to it on first validation — so a customer only configures
  // LICENSE_KEY. 'host-attributes' (no machine-id) is less stable in a
  // container: mount /etc/machine-id read-only to keep it fixed across recreates.
  if (config.license.serverIdSource === 'host-attributes') {
    logger.warn(
      `License: serverId ${config.license.serverId} derived from host attributes ` +
        '(no machine-id found) — mount /etc/machine-id read-only, or set ' +
        'LICENSE_SERVER_ID, to keep it stable across container recreation.'
    );
  } else {
    logger.info(
      `License: serverId ${config.license.serverId} (${config.license.serverIdSource}).`
    );
  }

  const db = createDb(config);
  // Telemetry store (storage split). Null unless TSDB_ENABLED — then the server
  // behaves exactly as before with all telemetry in MySQL. When present, the
  // Storage Counter reports both stores.
  const tsdb = config.tsdb.enabled ? createTsdb(config) : null;
  if (tsdb) {
    logger.info(`TSDB telemetry enabled → ${config.tsdb.host}:${config.tsdb.port}/${config.tsdb.database}`);
  }
  const locationsRepo = createLocationsRepository(db);
  const usersRepo = createUsersRepository(db);
  // JWT revocation: load users' revocation cutoffs and refresh periodically, so
  // requireAuth can reject pre-cutoff tokens synchronously (no per-request DB).
  const revocationRegistry = createRevocationRegistry({ usersRepo, logger });
  revocationRegistry.load().catch(() => {});
  revocationRegistry.start();
  setRevocationCheck(revocationRegistry.isRevoked);
  const agentsRepo = createAgentsRepository(db);
  const auditRepo = createAgentActionAuditRepository(db);
  const auditEventsRepo = createAuditEventsRepository(db);
  const auditLogRepo = createAuditLogRepository(db);
  const apiTokensRepo = createApiTokensRepository(db);
  const auditLogger = createAuditLogger({ auditLogRepo, logger });
  const enrollmentCodesRepo = createEnrollmentCodesRepository(db);
  const enrollmentStore = createEnrollmentStore(db);
  const agentTokensRepo = createAgentTokensRepository(db);
  const resultsRepo = createResultsRepository(db);
  const resultsTsdbRepo = tsdb
    ? createResultsTsdbRepository(tsdb, { latestWindowMinutes: config.tsdb.latestWindowMinutes })
    : null;
  const probeResultsRepo = createProbeResultsRepository(db);
  const incidentsRepo = createIncidentsRepository(db);
  const thresholdsRepo = createIncidentThresholdsRepository(db);
  // Derives incidents from active-probe results on ingest (open/resolve), using
  // per-location thresholds with a global fallback. Best-effort + resilient.
  const incidentService = createIncidentService({
    incidentsRepo, thresholdsRepo, agentsRepo, probeResultsRepo, logger,
  });

  // Agent binaries served from a local dir for frictionless enrollment. SHA-256
  // is computed + cached now (at startup), so nothing is hashed per request.
  // (Legacy — the default install flow serves the source bundle below instead.)
  const artifactStore = createArtifactStore({ dir: config.enroll.artifactsDir, logger });

  // Agent source bundle served at /enroll/agent-source.tgz — packaged +
  // checksummed at startup so the one-liner installs with no published binaries.
  const agentSourceStore = createAgentSourceStore({ dir: config.enroll.agentSourceDir, logger });

  // Self-contained agent binaries built via @yao-pkg/pkg and cached on disk.
  // The one-line installer prefers these (~60 MB) over pulling a 500 MB Docker
  // image or requiring Node.js on the target host.  Build runs in the background
  // so startup is not delayed; the install script falls back to the source bundle
  // until the first build completes.  Requires @yao-pkg/pkg as a devDependency
  // and AGENT_SOURCE_DIR to be set; warnings are logged when either is missing.
  const agentBinaryStore = createAgentBinaryStore({
    agentDir: config.enroll.agentSourceDir,
    cacheDir: config.enroll.agentBinaryCacheDir,
    logger,
  });

  // Signed agent releases: built + Ed25519-signed off-server, uploaded via
  // POST /agents/releases (verified on upload), kept under AGENT_RELEASE_DIR and
  // pushed to agents. The release public key is a SEPARATE trust anchor from the
  // license key (see src/license/releaseKey.js).
  const agentReleaseStore = createAgentReleaseStore({ dir: process.env.AGENT_RELEASE_DIR || '', logger });

  // License validation: validates a signed proof against blueeye-licens, with a
  // local cache + grace window for network outages. getAgentCount reads the live
  // WebSocket connection count (agentWs is assigned just below; the closure is
  // only invoked later, at validation time).
  let agentWs = null;
  let dashboardWs = null;
  let licenseManager;
  // Provenance of the configured public key, surfaced through
  // licenseManager.getStatus().publicKeyTrust so the dashboard can tell "the
  // licens server denied this" apart from "this server is verifying against
  // the wrong key" — both look identical (reason: 'invalid_signature') from
  // inside validateOnce().
  const keyTrust = {
    source: config.license.publicKeySource,
    configured: isConfigured(config.license.publicKey),
  };
  licenseManager = createLicenseManager({
    config: config.license,
    publicKey: config.license.publicKey,
    cache: createFileCache(config.license.cachePath),
    logger,
    getAgentCount: () => (agentWs ? agentWs.connectionCount() : 0),
    keyTrust,
  });

  // Plan service: resolves the active package (Pilot/Starter/Professional) from
  // the signed proof's plan field (or LICENSE_PLAN), and exposes its limits +
  // packaged feature flags. Additive to the license manager.
  const planService = createPlanService({ licenseManager, configPlan: config.license.plan });

  // Feature gate: signature-verified module entitlements (fail-closed), now also
  // OR-ing in the active plan's packaged features (rbac/reports_pdf/api_access…).
  const featureGate = createFeatureGate({ licenseManager, planService });

  // Lets HTTP routes push commands to connected agents over the WebSocket.
  // sendCommandAndWait also awaits the agent's correlated reply (Ping/Update).
  const agentCommander = {
    sendCommand: (agentId, command) => (agentWs ? agentWs.sendCommand(agentId, command) : 0),
    sendCommandAndWait: (agentId, command, opts) =>
      (agentWs
        ? agentWs.sendCommandAndWait(agentId, command, opts)
        : Promise.resolve({ delivered: 0, acked: false, reply: null })),
    getSflowStatus: (agentId) => (agentWs ? agentWs.getSflowStatus(agentId) : null),
    // Live connection evidence + forced re-dial for the connection diagnosis
    // (GET /agents/:id/connection, POST /agents/:id/reconnect).
    getConnectionInfo: (agentId) => (agentWs ? agentWs.getConnectionInfo(agentId) : null),
    disconnectAgent: (agentId, opts) => (agentWs ? agentWs.disconnectAgent(agentId, opts) : 0),
    // Push an agent's assigned transaction tests when they change (create/update/
    // delete/assign). Best-effort — resolves to 0 before the WS server is up.
    pushTransactionConfig: (agentId) => (agentWs ? agentWs.pushTransactionConfig(agentId) : Promise.resolve(0)),
  };

  // Test packages: server-defined probe/traffic test sets pushed to agents to
  // run, on a schedule or on demand. The runner reuses agentCommander to deliver
  // the items as run-probe/run-test commands.
  const testPackagesRepo = createTestPackagesRepository(db);
  const testPackageRunner = createTestPackageRunner({ agentsRepo, agentCommander, repo: testPackagesRepo, logger });
  const testPackageScheduler = createTestPackageScheduler({ repo: testPackagesRepo, runner: testPackageRunner, logger });
  // Active throughput ("speed test") results reported by agents.
  const speedtestResultsRepo = createSpeedtestResultsRepository(db);

  // Secret box: AES-256-GCM encryption for secrets stored at rest (integration
  // credentials, the LDAP bind password, transaction-test secrets). See
  // src/lib/secretBox.js.
  const secretBox = createSecretBox({ key: config.security.secretKey });

  // Transaction tests (http/tcp/dns/icmp journeys): config pushed to agents over
  // WS, results ingested over WS. Secrets (config_secrets) are AES-256-GCM at rest
  // via secretBox. See src/routes/transactions.js + src/ws/agentSocket.js.
  const transactionsRepo = createTransactionsRepository({ db, secretBox });

  // Agent-release signing key — generated + managed from Settings (write-once; the
  // private key is encrypted at rest via secretBox). It is the trust anchor for
  // secure agent management: the server signs agent releases with it and agents
  // verify those signatures. When no managed key is stored it falls back to the
  // env/embedded key, so deployments that set AGENT_RELEASE_PUBLIC_KEY keep working.
  const agentReleaseKeyRepo = createAgentReleaseKeyRepository(db);
  const releaseKeyService = createReleaseKeyService({ repo: agentReleaseKeyRepo, secretBox, logger });

  // Outbound API integrations (ITSM/IPAM connectors). The dispatcher fans domain
  // events (incidents/anomalies, agent enroll/delete) out to enabled targets with
  // debounce + retry/backoff, decrypting credentials only at fire time, and audits
  // every call. fetch is Node's global (mocked in tests).
  const integrationsRepo = createIntegrationsRepository(db);
  const integrationAuditRepo = createIntegrationAuditRepository(db);
  const connectorRegistry = createConnectorRegistry({ fetchImpl: globalThis.fetch, logger });
  const integrationsDispatcher = createIntegrationsDispatcher({
    integrationsRepo, auditRepo: integrationAuditRepo, secretBox, registry: connectorRegistry, logger,
  });

  // CMDB integration (single source of truth): the singleton connection config +
  // per-agent asset links. Reuses connectorRegistry (ServiceNow/Nautobot) for the
  // connection test + asset search, and secretBox to encrypt credentials at rest.
  const cmdbConfigRepo = createCmdbConfigRepository(db);
  const agentCmdbLinksRepo = createAgentCmdbLinksRepository(db);

  // External auth (LDAP/AD). OFF unless LDAP_AUTH_ENABLED=true, the licence covers
  // it (sso_ldap), AND an admin has stored + enabled a config row. Local JWT login
  // always remains as the fallback.
  const ldapConfigRepo = createLdapConfigRepository(db);
  const ldapRoleMapRepo = createLdapRoleMapRepository(db);
  const ldapLoginAuditRepo = createLdapLoginAuditRepository(db);
  const ldapAuth = createLdapAuth({ config: config.ldap, ldapConfigRepo, ldapRoleMapRepo, secretBox, featureGate, logger });

  // SSO (OIDC). OFF unless OIDC_AUTH_ENABLED=true, the licence covers it
  // (sso_oidc) AND the issuer/client/redirect are env-configured. The group→role
  // map is admin-managed; the (shared) SSO login audit records every attempt.
  // Local JWT login always remains as the fallback.
  const ssoLoginAuditRepo = createSsoLoginAuditRepository(db);
  const oidcRoleMapRepo = createOidcRoleMapRepository(db);
  const oidcAuth = createOidcAuth({ config: config.oidc, oidcRoleMapRepo, featureGate, logger });

  // SSO (SAML 2.0, SP-initiated). OFF unless SAML_AUTH_ENABLED=true, the licence
  // covers it (sso_saml) AND the IdP entry-point/cert/SP entityID are
  // env-configured. Attribute→role mapping is admin-managed. Local login stays.
  const samlRoleMapRepo = createSamlRoleMapRepository(db);
  const samlAuth = createSamlAuth({ config: config.saml, samlRoleMapRepo, featureGate, logger });

  // NIS2 Reporting Center repositories (risk register, control evidence, security
  // incidents, generated reports, evidence references, and the module audit log).
  const nis2RisksRepo = createNis2RisksRepository(db);
  const nis2ControlsRepo = createNis2ControlsRepository(db);
  const nis2IncidentsRepo = createNis2IncidentsRepository(db);
  const nis2ReportsRepo = createNis2ReportsRepository(db);
  const nis2EvidenceRepo = createNis2EvidenceRepository(db);
  const nis2AuditRepo = createNis2AuditRepository(db);

  // Pushes a live event to every connected dashboard (assigned below; the
  // closure runs later). Used for enrollment/agent-status feedback in the UI.
  const notifyDashboard = (message) => (dashboardWs ? dashboardWs.broadcast(message) : 0);

  // Usage service: counts agents / active test paths for plan-limit enforcement
  // and the admin "Usage overview" panel. Wired after its repositories exist.
  const usageService = createUsageService({
    agentsRepo,
    testPackagesRepo,
    planService,
    licenseManager,
  });

  // Storage info (disk free/used + database size).
  const systemInfo = createSystemInfo({ db, tsdb, diskPath: config.storage.diskPath });

  // Analysis module: findings store + detector pipeline hung off ingest. The
  // detector pushes findings to the UI over the SAME WebSocket (agentWs is
  // assigned just below; the closure runs later, at ingest time).
  const analysisConfig = loadAnalysisConfig();
  const findingStore = new FindingStore({ db });
  const investigationsRepo = createInvestigationsRepository(db);
  const baselineCache = createBaselineFileCache(config.analysis.baselineCachePath);
  const baselines = createBaselineStore({
    store: baselineCache,
    minSamples: analysisConfig.minSamples,
    // Persist off the per-sample ingest path: debounce disk writes to ~30s.
    persistIntervalMs: 30000,
  });
  const detector = createDetector({ baselines, config: analysisConfig });
  const correlator = createCorrelator(); // uses src/analysis/dependency-graph.json

  // Incident cases: first-class incidents wrapping findings. The service groups
  // each newly-detected finding into an open incident on the same device (within
  // the correlator window) or opens a new one; wired into both analysis pipelines.
  const incidentCasesRepo = createIncidentCasesRepository(db);
  const configSnapshotsRepo = createConfigSnapshotsRepository(db);
  const incidentCaseService = createIncidentCaseService({ incidentCasesRepo, findingStore, configSnapshotsRepo, logger });

  // Alerting: route findings to channels (email/webhook/syslog). Channels are
  // built unconditionally so the test endpoint works; rules/enable live in
  // config. Outgoing sends use Node's fetch / dgram / (lazy) nodemailer.
  const alertingConfig = loadAlertingConfig();
  const dispatcher = createDispatcher({
    config: alertingConfig,
    channels: {
      // createTransport (not an eager transport) so a runtime SMTP edit (Settings
      // → Alerting) rebuilds the mailer without a restart.
      email: createEmailChannel({ config: alertingConfig.channels.email, createTransport: (smtp) => createSmtpTransport(smtp, logger), logger }),
      webhook: createWebhookChannel({ config: alertingConfig.channels.webhook, logger }),
      syslog: createSyslogChannel({ config: alertingConfig.channels.syslog, logger }),
    },
    // Alerting dispatches if the license includes the legacy `alerting` module
    // OR the plan grants an alert channel feature (so plan-based Professional+
    // installs alert without a legacy proof feature map).
    licensed: () =>
      featureGate.isFeatureEnabled('alerting') ||
      featureGate.isFeatureEnabled('alerts_email') ||
      featureGate.isFeatureEnabled('alerts_webhook'),
    // Per-channel gate: email/webhook honour their plan feature keys, falling
    // back to the legacy `alerting` entitlement; syslog stays under `alerting`.
    channelLicensed: (name) => {
      if (name === 'email') return featureGate.isFeatureEnabled('alerts_email') || featureGate.isFeatureEnabled('alerting');
      if (name === 'webhook') return featureGate.isFeatureEnabled('alerts_webhook') || featureGate.isFeatureEnabled('alerting');
      return featureGate.isFeatureEnabled('alerting');
    },
    logger,
  });
  // Maintenance windows suppress notifications (findings still record). The
  // silencer reads windows from settingsService, which is built further down, so
  // it's bound after that. (createSilencer is in alerting/maintenance.js.)

  const analysisPipeline = createAnalysisPipeline({
    detector,
    findingStore,
    config: analysisConfig,
    correlator,
    incidentCaseService,
    dispatcher,
    // Live getter (not a snapshot) so a runtime enable in Settings → Alerting applies.
    alertingEnabled: () => alertingConfig.enabled,
    // Outbound integrations fire on findings independently of local alerting.
    integrationTrigger: integrationsDispatcher,
    // Detector runs only if the license includes analysis (AND config enables it).
    licensed: () => featureGate.isFeatureEnabled('analysis'),
    // Push findings to connected dashboards (browsers), not to agents.
    publishFinding: (hostId, message) => (dashboardWs ? dashboardWs.broadcast(message) : 0),
    logger,
  });
  // Offline GeoIP/ASN provider (EU-sourced range DB; config.geo.dbPath). Created
  // here so the probe pipeline can resolve traceroute hop IPs → ASNs for AS-path
  // change detection; reused below for flow enrichment and the path/destination
  // maps. Without a DB it simply no-ops (no country/ASN).
  const geoProvider = createGeoProvider({ dbPath: config.geo.dbPath, logger });

  // Active-probe analysis: derive findings (reachability/loss/latency/jitter/cert/
  // AS-path change) from probe-results on ingest, alongside the traffic detector
  // above. Shares the analysis license+flag and the same alerting dispatcher +
  // dashboard publish.
  const probePipeline = createProbePipeline({
    probeResultsRepo,
    findingStore,
    config: analysisConfig,
    dispatcher,
    incidentCaseService,
    alertingEnabled: () => alertingConfig.enabled,
    integrationTrigger: integrationsDispatcher,
    licensed: () => featureGate.isFeatureEnabled('analysis'),
    geoProvider,
    publishFinding: (hostId, message) => (dashboardWs ? dashboardWs.broadcast(message) : 0),
    logger,
  });

  // Opt-in LLM assistant (off unless ANALYSIS_ASSISTANT_ENABLED=true). Reads the
  // findings store for its compact context, plus agents/locations/probe health
  // for the per-location "what's going on here?" summary.
  const assistant = createAssistant({
    config: analysisConfig, findingStore, agentsRepo, locationsRepo, probeResultsRepo, logger,
  });

  // Geo layer: enrich + store flow records. The GeoIP provider (created above for
  // the probe pipeline) reads an offline, EU-sourced range DB; without it, flows
  // store without country/ASN. RFC1918/private endpoints are never geolocated.
  const flowsRepo = createFlowsRepository(db);
  const centroids = createCentroids();
  const geoEnricher = createGeoEnricher({ provider: geoProvider, centroids });
  const flowPipeline = createFlowPipeline({
    flowsRepo,
    enricher: geoEnricher,
    config: { geoEnabled: config.geo.enabled },
    logger,
  });

  // Retention: nightly rollup (down-sample raw -> rollup tables) + purge of
  // expired data. DB hygiene; on by default. Started after the server is up.
  const retentionConfig = loadRetentionConfig();
  const retentionRepo = createRetentionRepo(db);

  // Runtime-editable settings (map tile/geocoder, traffic-type categories, and
  // the analysis/retention knobs — which it mutates on the live config objects).
  const settingsService = createSettingsService({
    settingsRepo: createSettingsRepository(db), config,
    liveAnalysis: analysisConfig, liveRetention: retentionConfig, liveAlerting: alertingConfig,
    liveGeo: geoProvider, secretBox,
  });
  // Re-apply persisted analysis/retention edits onto the live config so they
  // survive restarts. Best-effort + fire-and-forget (consumers read lazily).
  settingsService.applyStoredOverrides().catch((err) => logger.warn(`settings: could not apply stored overrides (${err.message})`));
  // In-app GeoIP updater: powers Settings → Map "Update now" and the opt-in
  // monthly auto-refresh (writes the built CSV into the /data volume, reloads the
  // provider). Egress is admin-initiated / opt-in, so air-gapped installs are fine.
  const geoipUpdater = createGeoipUpdater({ settingsService, config, logger });
  // NB: the GeoIP auto-update schedule is a singleton job — it is started by the
  // HA coordinator (leader-only), not eagerly here, so multiple replicas don't
  // all refresh the shared data volume. On a single node the coordinator (HA
  // off) starts it immediately, preserving the previous behaviour.
  // Auto-install of missing diagnostic tools (opt-in via Settings → Agents):
  // pushes an install-tool command when a probe fails because the tool is
  // missing on the host. Threaded into probe ingest below.
  const installToolService = createInstallToolService({
    agentCommander, auditRepo, auditEventsRepo, agentsRepo, settingsService, logger,
  });
  // Now that settingsService exists, give the dispatcher its maintenance silencer.
  dispatcher.setSilencer(createSilencer({
    getWindows: async () => (await settingsService.getMaintenance()).windows,
    getAgentLocationId: async (agentId) => { const a = await agentsRepo.findById(agentId); return a ? a.location_id : null; },
  }));
  const retentionScheduler = createRetentionScheduler({
    rollup: createRollup({ repo: retentionRepo, config: retentionConfig, logger }),
    purge: createPurge({ repo: retentionRepo, config: retentionConfig }),
    config: retentionConfig,
    logger,
  });

  // Singleton background jobs for this single-node install: retention
  // rollup/purge, the test-package scheduler, GeoIP auto-update, the hourly MAD
  // baseline recompute for transaction tests, and incident auto-resolve. They
  // are started on boot and stopped on graceful shutdown.
  const backgroundJobs = [
    retentionScheduler,
    testPackageScheduler,
    // GeoIP exposes startSchedule/stopSchedule; adapt it to the uniform { start, stop }.
    { start: () => geoipUpdater.startSchedule(), stop: () => geoipUpdater.stopSchedule() },
    createTransactionBaselineJob({ repo: transactionsRepo, logger }),
    createIncidentAutoResolveJob({ incidentCasesRepo, auditLogRepo, logger }),
  ];
  function startBackgroundJobs() {
    for (const job of backgroundJobs) {
      try { job.start(); } catch (err) { logger.error(`background job start failed (${err && err.message})`); }
    }
  }
  function stopBackgroundJobs() {
    for (const job of backgroundJobs) {
      try { job.stop(); } catch (err) { logger.error(`background job stop failed (${err && err.message})`); }
    }
  }

  const app = createApp({
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
    agentCommander,
    systemInfo,
    licenseManager,
    findingStore,
    analysisPipeline,
    probePipeline,
    flowPipeline,
    flowsRepo,
    geoTileConfig: config.geo,
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
    releaseStore: agentReleaseStore,
    // A live resolver (not a static value): generating/deleting the key in Settings
    // takes effect without a restart.
    releasePublicKey: () => releaseKeyService.getPublicKey(),
    releaseKeyService,
    testPackagesRepo,
    testPackageRunner,
    transactionsRepo,
    speedtestResultsRepo,
    integrationsRepo,
    integrationAuditRepo,
    integrationsDispatcher,
    connectorRegistry,
    secretBox,
    cmdbConfigRepo,
    agentCmdbLinksRepo,
    // Outbound fetch for the Test area's reachability probes (SAML IdP / assistant).
    diagnosticsFetch: globalThis.fetch,
    ldapConfigRepo,
    ldapRoleMapRepo,
    ldapLoginAuditRepo,
    ldapAuth,
    ldapAuthEnabledFlag: config.ldap.authEnabled,
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
    enrollConfig: { publicUrl: config.publicUrl, certFingerprint: config.enroll.certFingerprint, defaultTtlMinutes: config.enrollment.defaultTtlMinutes },
    notifyDashboard,
    // Brute-force throttle for agent enrollment by IP (login has its own
    // loginThrottle inside the auth router).
    enrollRateLimiter: createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 }),
    logger,
    logRing,
  });

  const server = app.listen(config.port, () => {
    logger.info(
      `blueeye-server listening on port ${config.port} (env: ${config.env})`
    );
  });

  // Load the managed signing key into memory, then publish a signed release from the
  // current agent source so upgrades are ready with no extra steps. Best-effort — a
  // missing key just means unsigned source installs until one is generated.
  releaseKeyService.load()
    .then(() => publishSignedReleaseFromSource({ sourceStore: agentSourceStore, releaseStore: agentReleaseStore, releaseKeyService, logger }))
    .catch((err) => logger.warn(`agent release key: startup load/publish failed: ${err.message}`));

  // Live agent channel (WebSocket). New connections are gated by the license
  // (capacity + validity) — this is separate from agent-token authentication.
  agentWs = attachAgentWebSocket({
    server,
    agentTokensRepo,
    agentsRepo,
    auditRepo,
    auditEventsRepo,
    logger,
    path: config.ws.path,
    heartbeatMs: config.ws.heartbeatIntervalMs,
    licenseGuard: (count) => licenseManager.canAcceptNewConnection(count),
    // Push live online/offline transitions to the dashboard.
    notifyDashboard,
    // Transaction-test channel: config push on connect/change + result ingest +
    // threshold alerting (reuses the same dispatcher as probe/analysis findings).
    // The assistant supplies an optional Danish diagnosis (falls back to a template).
    transactionsRepo,
    alertDispatcher: dispatcher,
    alertingEnabled: () => alertingConfig.enabled,
    assistant,
  });

  // Browser live channel (analysis findings -> dashboard), gated by the user JWT.
  // Mirror requireAuth: also reject tokens revoked by a password/role change or
  // deprovision, so a withdrawn user can't keep a live socket open until the JWT
  // naturally expires.
  dashboardWs = attachDashboardWebSocket({
    server,
    verifyToken: (token) => {
      const decoded = verifyToken(token);
      if (revocationRegistry.isRevoked(Number(decoded.sub), decoded.iat)) return null;
      return decoded;
    },
    logger,
    path: config.ws.dashboardPath,
    heartbeatMs: config.ws.heartbeatIntervalMs,
  });

  // Both WebSocket servers are cooperative (they ignore paths that aren't
  // theirs). Reject any upgrade to an unknown path so stray sockets don't hang.
  const knownWsPaths = new Set([config.ws.path, config.ws.dashboardPath]);
  server.on('upgrade', (req, socket) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = req.url;
    }
    if (!knownWsPaths.has(pathname)) socket.destroy();
  });

  if (!keyTrust.configured) {
    logger.warn(
      'License public key is not configured (placeholder) — proofs cannot be verified and agents will not be licensed. See src/license/publicKey.js.'
    );
  }
  // Validate at startup, then periodically. Failures fall back to cache + grace.
  licenseManager.start().catch((err) => logger.error('License manager error:', err));

  // Start the singleton background jobs — retention rollup/purge, the
  // test-package scheduler, the GeoIP auto-update, the transaction baseline
  // recompute and incident auto-resolve.
  startBackgroundJobs();

  function shutdown(signal) {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    licenseManager.stop();
    // Stops the singleton background jobs.
    stopBackgroundJobs();
    baselines.stop();
    revocationRegistry.stop();
    agentWs.close();
    dashboardWs.close();
    server.close(async () => {
      try {
        await db.close();
      } catch (err) {
        logger.error('Error while closing the database pool:', err);
      }
      if (tsdb) {
        try {
          await tsdb.close();
        } catch (err) {
          logger.error('Error while closing the TSDB pool:', err);
        }
      }
      process.exit(0);
    });
    // Don't hang forever if connections refuse to drain.
    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { start };
