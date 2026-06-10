'use strict';

const { config } = require('./config');
const { createDb } = require('./db');
const { createApp } = require('./app');
const { createLocationsRepository } = require('./repositories/locationsRepository');
const { createUsersRepository } = require('./repositories/usersRepository');
const { createAgentsRepository } = require('./repositories/agentsRepository');
const { createAgentActionAuditRepository } = require('./repositories/agentActionAuditRepository');
const { createAuditEventsRepository } = require('./repositories/auditEventsRepository');
const { createAuditLogRepository } = require('./repositories/auditLogRepository');
const { createApiTokensRepository } = require('./repositories/apiTokensRepository');
const { createAuditLogger } = require('./services/auditLogger');
const { createEnrollmentCodesRepository } = require('./repositories/enrollmentCodesRepository');
const { createEnrollmentStore } = require('./services/enrollmentStore');
const { createAgentTokensRepository } = require('./repositories/agentTokensRepository');
const { createResultsRepository } = require('./repositories/resultsRepository');
const { createProbeResultsRepository } = require('./repositories/probeResultsRepository');
const { createIncidentsRepository } = require('./repositories/incidentsRepository');
const { createIncidentThresholdsRepository } = require('./repositories/incidentThresholdsRepository');
const { createIncidentService } = require('./incidents/incidentService');
const { createArtifactStore } = require('./enroll/artifactStore');
const { createAgentSourceStore } = require('./enroll/agentSourceStore');
const { createAgentReleaseStore } = require('./enroll/agentReleaseStore');
const { createAgentReleaseKeyRepository } = require('./repositories/agentReleaseKeyRepository');
const { createReleaseKeyService } = require('./enroll/releaseKeyService');
const { publishSignedReleaseFromSource } = require('./enroll/publishSignedRelease');
const { attachAgentWebSocket } = require('./ws/agentSocket');
const { attachDashboardWebSocket } = require('./ws/dashboardSocket');
const { verifyToken } = require('./auth/jwt');
const { createLicenseManager } = require('./license/licenseManager');
const { createLicenseVerifier } = require('./license/licenseVerifier');
const { createOfflineLicenseManager } = require('./license/offlineLicenseManager');
const { createFeatureGate } = require('./license/features');
const { createPlanService } = require('./license/planService');
const { createUsageService } = require('./services/usageService');
const { createFileCache } = require('./license/licenseCache');
const { isConfigured } = require('./license/publicKey');
const { createSystemInfo } = require('./services/systemInfo');
const { FindingStore } = require('./analysis/findings');
const { createBaselineStore } = require('./analysis/baselines');
const { createDetector } = require('./analysis/detector');
const { createAnalysisPipeline } = require('./analysis/pipeline');
const { createProbePipeline } = require('./analysis/probePipeline');
const { createCorrelator } = require('./analysis/correlator');
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
const { createTestPackageRunner } = require('./services/testPackageRunner');
const { createTestPackageScheduler } = require('./services/testPackageScheduler');
const { createSpeedtestResultsRepository } = require('./repositories/speedtestResultsRepository');
const { createSecretBox } = require('./lib/secretBox');
const { createIntegrationsRepository } = require('./repositories/integrationsRepository');
const { createIntegrationAuditRepository } = require('./repositories/integrationAuditRepository');
const { createConnectorRegistry } = require('./integrations/connectors');
const { createIntegrationsDispatcher } = require('./integrations/dispatcher');
const { createLdapConfigRepository } = require('./repositories/ldapConfigRepository');
const { createLdapRoleMapRepository } = require('./repositories/ldapRoleMapRepository');
const { createLdapLoginAuditRepository } = require('./repositories/ldapLoginAuditRepository');
const { createLdapAuth } = require('./auth/ldap');
const { createNis2RisksRepository } = require('./repositories/nis2RisksRepository');
const { createNis2ControlsRepository } = require('./repositories/nis2ControlsRepository');
const { createNis2IncidentsRepository } = require('./repositories/nis2IncidentsRepository');
const { createNis2ReportsRepository } = require('./repositories/nis2ReportsRepository');
const { createNis2EvidenceRepository } = require('./repositories/nis2EvidenceRepository');
const { createNis2AuditRepository } = require('./repositories/nis2AuditRepository');

// Wires up real dependencies, starts the HTTP server and installs graceful
// shutdown handlers.
function start() {
  // Never run in production with the built-in development JWT secret.
  if (config.env === 'production' && config.auth.usingDefaultSecret) {
    console.error(
      'Refusing to start: JWT_SECRET must be set to a strong value in production.'
    );
    process.exit(1);
  }

  const db = createDb(config);
  const locationsRepo = createLocationsRepository(db);
  const usersRepo = createUsersRepository(db);
  const agentsRepo = createAgentsRepository(db);
  const auditRepo = createAgentActionAuditRepository(db);
  const auditEventsRepo = createAuditEventsRepository(db);
  const auditLogRepo = createAuditLogRepository(db);
  const apiTokensRepo = createApiTokensRepository(db);
  const auditLogger = createAuditLogger({ auditLogRepo, logger: console });
  const enrollmentCodesRepo = createEnrollmentCodesRepository(db);
  const enrollmentStore = createEnrollmentStore(db);
  const agentTokensRepo = createAgentTokensRepository(db);
  const resultsRepo = createResultsRepository(db);
  const probeResultsRepo = createProbeResultsRepository(db);
  const incidentsRepo = createIncidentsRepository(db);
  const thresholdsRepo = createIncidentThresholdsRepository(db);
  // Derives incidents from active-probe results on ingest (open/resolve), using
  // per-location thresholds with a global fallback. Best-effort + resilient.
  const incidentService = createIncidentService({
    incidentsRepo, thresholdsRepo, agentsRepo, probeResultsRepo, logger: console,
  });

  // Agent binaries served from a local dir for frictionless enrollment. SHA-256
  // is computed + cached now (at startup), so nothing is hashed per request.
  // (Legacy — the default install flow serves the source bundle below instead.)
  const artifactStore = createArtifactStore({ dir: config.enroll.artifactsDir, logger: console });

  // Agent source bundle served at /enroll/agent-source.tgz — packaged +
  // checksummed at startup so the one-liner installs with no published binaries.
  const agentSourceStore = createAgentSourceStore({ dir: config.enroll.agentSourceDir, logger: console });

  // Signed agent releases: built + Ed25519-signed off-server, uploaded via
  // POST /agents/releases (verified on upload), kept under AGENT_RELEASE_DIR and
  // pushed to agents. The release public key is a SEPARATE trust anchor from the
  // license key (see src/license/releaseKey.js).
  const agentReleaseStore = createAgentReleaseStore({ dir: process.env.AGENT_RELEASE_DIR || '', logger: console });

  // License validation. Two interchangeable backends with the SAME surface:
  //   - ONLINE  (default): validates a signed proof against blueeye-licens.
  //   - OFFLINE (LICENSE_FILE set): validates a local signed license file
  //     entirely on-box — no external server. Invalid/expired → restricted mode.
  // getAgentCount reads the live WebSocket connection count (agentWs is assigned
  // just below; the closure is only invoked later, at validation time).
  let agentWs = null;
  let dashboardWs = null;
  let licenseManager;
  if (config.license.mode === 'offline') {
    const verifier = createLicenseVerifier({
      publicKey: config.license.publicKey,
      serverId: config.license.serverId,
    });
    licenseManager = createOfflineLicenseManager({
      verifier,
      filePath: config.license.file,
      serverId: config.license.serverId,
      recheckHours: config.license.recheckHours,
      logger: console,
    });
    console.log(`License mode: offline (file=${config.license.file || 'unset'}).`);
  } else {
    licenseManager = createLicenseManager({
      config: config.license,
      publicKey: config.license.publicKey,
      cache: createFileCache(config.license.cachePath),
      logger: console,
      getAgentCount: () => (agentWs ? agentWs.connectionCount() : 0),
    });
  }

  // Plan service: resolves the active package (Pilot/Starter/Professional/
  // Enterprise/MSP) from the signed proof's plan field (or LICENSE_PLAN), and
  // exposes its limits + packaged feature flags. Additive to the license manager.
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
  };

  // Test packages: server-defined probe/traffic test sets pushed to agents to
  // run, on a schedule or on demand. The runner reuses agentCommander to deliver
  // the items as run-probe/run-test commands.
  const testPackagesRepo = createTestPackagesRepository(db);
  const testPackageRunner = createTestPackageRunner({ agentsRepo, agentCommander, repo: testPackagesRepo, logger: console });
  const testPackageScheduler = createTestPackageScheduler({ repo: testPackagesRepo, runner: testPackageRunner, logger: console });
  // Active throughput ("speed test") results reported by agents.
  const speedtestResultsRepo = createSpeedtestResultsRepository(db);

  // Secret box: AES-256-GCM encryption for secrets stored at rest (integration
  // credentials, the LDAP bind password). See src/lib/secretBox.js.
  const secretBox = createSecretBox({ key: config.security.secretKey });

  // Agent-release signing key — generated + managed from Settings (write-once; the
  // private key is encrypted at rest via secretBox). It is the trust anchor for
  // secure agent management: the server signs agent releases with it and agents
  // verify those signatures. When no managed key is stored it falls back to the
  // env/embedded key, so deployments that set AGENT_RELEASE_PUBLIC_KEY keep working.
  const agentReleaseKeyRepo = createAgentReleaseKeyRepository(db);
  const releaseKeyService = createReleaseKeyService({ repo: agentReleaseKeyRepo, secretBox, logger: console });

  // Outbound API integrations (ITSM/IPAM connectors). The dispatcher fans domain
  // events (incidents/anomalies, agent enroll/delete) out to enabled targets with
  // debounce + retry/backoff, decrypting credentials only at fire time, and audits
  // every call. fetch is Node's global (mocked in tests).
  const integrationsRepo = createIntegrationsRepository(db);
  const integrationAuditRepo = createIntegrationAuditRepository(db);
  const connectorRegistry = createConnectorRegistry({ fetchImpl: globalThis.fetch, logger: console });
  const integrationsDispatcher = createIntegrationsDispatcher({
    integrationsRepo, auditRepo: integrationAuditRepo, secretBox, registry: connectorRegistry, logger: console,
  });

  // External auth (LDAP/AD). OFF unless LDAP_AUTH_ENABLED=true, the licence covers
  // it (sso_ldap), AND an admin has stored + enabled a config row. Local JWT login
  // always remains as the fallback.
  const ldapConfigRepo = createLdapConfigRepository(db);
  const ldapRoleMapRepo = createLdapRoleMapRepository(db);
  const ldapLoginAuditRepo = createLdapLoginAuditRepository(db);
  const ldapAuth = createLdapAuth({ config: config.ldap, ldapConfigRepo, ldapRoleMapRepo, secretBox, featureGate, logger: console });

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
  const systemInfo = createSystemInfo({ db, diskPath: config.storage.diskPath });

  // Analysis module: findings store + detector pipeline hung off ingest. The
  // detector pushes findings to the UI over the SAME WebSocket (agentWs is
  // assigned just below; the closure runs later, at ingest time).
  const analysisConfig = loadAnalysisConfig();
  const findingStore = new FindingStore({ db });
  const baselineCache = createFileCache(config.analysis.baselineCachePath);
  const baselines = createBaselineStore({ store: baselineCache, minSamples: analysisConfig.minSamples });
  const detector = createDetector({ baselines, config: analysisConfig });
  const correlator = createCorrelator(); // uses src/analysis/dependency-graph.json

  // Alerting: route findings to channels (email/webhook/syslog). Channels are
  // built unconditionally so the test endpoint works; rules/enable live in
  // config. Outgoing sends use Node's fetch / dgram / (lazy) nodemailer.
  const alertingConfig = loadAlertingConfig();
  const dispatcher = createDispatcher({
    config: alertingConfig,
    channels: {
      // createTransport (not an eager transport) so a runtime SMTP edit (Settings
      // → Alerting) rebuilds the mailer without a restart.
      email: createEmailChannel({ config: alertingConfig.channels.email, createTransport: (smtp) => createSmtpTransport(smtp, console), logger: console }),
      webhook: createWebhookChannel({ config: alertingConfig.channels.webhook, logger: console }),
      syslog: createSyslogChannel({ config: alertingConfig.channels.syslog, logger: console }),
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
    logger: console,
  });
  // Maintenance windows suppress notifications (findings still record). The
  // silencer reads windows from settingsService, which is built further down, so
  // it's bound after that. (createSilencer is in alerting/maintenance.js.)

  const analysisPipeline = createAnalysisPipeline({
    detector,
    findingStore,
    config: analysisConfig,
    correlator,
    dispatcher,
    // Live getter (not a snapshot) so a runtime enable in Settings → Alerting applies.
    alertingEnabled: () => alertingConfig.enabled,
    // Outbound integrations fire on findings independently of local alerting.
    integrationTrigger: integrationsDispatcher,
    // Detector runs only if the license includes analysis (AND config enables it).
    licensed: () => featureGate.isFeatureEnabled('analysis'),
    // Push findings to connected dashboards (browsers), not to agents.
    publishFinding: (hostId, message) => (dashboardWs ? dashboardWs.broadcast(message) : 0),
    logger: console,
  });
  // Active-probe analysis: derive findings (reachability/loss/latency/jitter/cert)
  // from probe-results on ingest, alongside the traffic detector above. Shares the
  // analysis license+flag and the same alerting dispatcher + dashboard publish.
  const probePipeline = createProbePipeline({
    probeResultsRepo,
    findingStore,
    config: analysisConfig,
    dispatcher,
    alertingEnabled: () => alertingConfig.enabled,
    integrationTrigger: integrationsDispatcher,
    licensed: () => featureGate.isFeatureEnabled('analysis'),
    publishFinding: (hostId, message) => (dashboardWs ? dashboardWs.broadcast(message) : 0),
    logger: console,
  });

  // Opt-in LLM assistant (off unless ANALYSIS_ASSISTANT_ENABLED=true). Reads the
  // findings store for its compact context, plus agents/locations/probe health
  // for the per-location "what's going on here?" summary.
  const assistant = createAssistant({
    config: analysisConfig, findingStore, agentsRepo, locationsRepo, probeResultsRepo, logger: console,
  });

  // Geo layer: enrich + store flow records. The GeoIP provider reads an offline,
  // EU-sourced range DB (config.geo.dbPath); without it, flows store without
  // country/ASN. RFC1918/private endpoints are never geolocated.
  const flowsRepo = createFlowsRepository(db);
  const geoProvider = createGeoProvider({ dbPath: config.geo.dbPath, logger: console });
  const centroids = createCentroids();
  const geoEnricher = createGeoEnricher({ provider: geoProvider, centroids });
  const flowPipeline = createFlowPipeline({
    flowsRepo,
    enricher: geoEnricher,
    config: { geoEnabled: config.geo.enabled },
    logger: console,
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
    liveGeo: geoProvider,
  });
  // Re-apply persisted analysis/retention edits onto the live config so they
  // survive restarts. Best-effort + fire-and-forget (consumers read lazily).
  settingsService.applyStoredOverrides().catch((err) => console.warn(`settings: could not apply stored overrides (${err.message})`));
  // In-app GeoIP updater: powers Settings → Map "Update now" and the opt-in
  // monthly auto-refresh (writes the built CSV into the /data volume, reloads the
  // provider). Egress is admin-initiated / opt-in, so air-gapped installs are fine.
  const geoipUpdater = createGeoipUpdater({ settingsService, config, logger: console });
  geoipUpdater.startSchedule();
  // Now that settingsService exists, give the dispatcher its maintenance silencer.
  dispatcher.setSilencer(createSilencer({
    getWindows: async () => (await settingsService.getMaintenance()).windows,
    getAgentLocationId: async (agentId) => { const a = await agentsRepo.findById(agentId); return a ? a.location_id : null; },
  }));
  const retentionScheduler = createRetentionScheduler({
    rollup: createRollup({ repo: retentionRepo, config: retentionConfig, logger: console }),
    purge: createPurge({ repo: retentionRepo, config: retentionConfig }),
    config: retentionConfig,
    logger: console,
  });

  const app = createApp({
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
    releaseStore: agentReleaseStore,
    // A live resolver (not a static value): generating/deleting the key in Settings
    // takes effect without a restart.
    releasePublicKey: () => releaseKeyService.getPublicKey(),
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
    ldapAuthEnabledFlag: config.ldap.authEnabled,
    nis2RisksRepo,
    nis2ControlsRepo,
    nis2IncidentsRepo,
    nis2ReportsRepo,
    nis2EvidenceRepo,
    nis2AuditRepo,
    enrollConfig: { publicUrl: config.publicUrl, certFingerprint: config.enroll.certFingerprint },
    notifyDashboard,
    logger: console,
  });

  const server = app.listen(config.port, () => {
    console.info(
      `blueeye-server listening on port ${config.port} (env: ${config.env})`
    );
  });

  // Load the managed signing key into memory, then publish a signed release from the
  // current agent source so upgrades are ready with no extra steps. Best-effort — a
  // missing key just means unsigned source installs until one is generated.
  releaseKeyService.load()
    .then(() => publishSignedReleaseFromSource({ sourceStore: agentSourceStore, releaseStore: agentReleaseStore, releaseKeyService, logger: console }))
    .catch((err) => console.warn(`agent release key: startup load/publish failed: ${err.message}`));

  // Live agent channel (WebSocket). New connections are gated by the license
  // (capacity + validity) — this is separate from agent-token authentication.
  agentWs = attachAgentWebSocket({
    server,
    agentTokensRepo,
    agentsRepo,
    auditRepo,
    logger: console,
    path: config.ws.path,
    heartbeatMs: config.ws.heartbeatIntervalMs,
    licenseGuard: (count) => licenseManager.canAcceptNewConnection(count),
    // Push live online/offline transitions to the dashboard.
    notifyDashboard,
  });

  // Browser live channel (analysis findings -> dashboard), gated by the user JWT.
  dashboardWs = attachDashboardWebSocket({
    server,
    verifyToken,
    logger: console,
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

  if (!isConfigured(config.license.publicKey)) {
    console.warn(
      'License public key is not configured (placeholder) — proofs cannot be verified and agents will not be licensed. See src/license/publicKey.js.'
    );
  }
  // Validate at startup, then periodically. Failures fall back to cache + grace.
  licenseManager.start().catch((err) => console.error('License manager error:', err));

  // Periodic retention rollup + purge (behind RETENTION_ENABLED, default on).
  retentionScheduler.start();

  // Periodic test-package scheduler: runs enabled, scheduled packages when due.
  testPackageScheduler.start();

  function shutdown(signal) {
    console.info(`Received ${signal}, shutting down gracefully...`);
    licenseManager.stop();
    retentionScheduler.stop();
    testPackageScheduler.stop();
    agentWs.close();
    dashboardWs.close();
    server.close(async () => {
      try {
        await db.close();
      } catch (err) {
        console.error('Error while closing the database pool:', err);
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
