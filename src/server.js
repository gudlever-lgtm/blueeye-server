'use strict';

const { config } = require('./config');
const { createDb } = require('./db');
const { createApp } = require('./app');
const { createLocationsRepository } = require('./repositories/locationsRepository');
const { createUsersRepository } = require('./repositories/usersRepository');
const { createAgentsRepository } = require('./repositories/agentsRepository');
const { createEnrollmentCodesRepository } = require('./repositories/enrollmentCodesRepository');
const { createEnrollmentStore } = require('./services/enrollmentStore');
const { createAgentTokensRepository } = require('./repositories/agentTokensRepository');
const { createResultsRepository } = require('./repositories/resultsRepository');
const { createProbeResultsRepository } = require('./repositories/probeResultsRepository');
const { createArtifactStore } = require('./enroll/artifactStore');
const { createAgentSourceStore } = require('./enroll/agentSourceStore');
const { createAgentReleaseStore } = require('./enroll/agentReleaseStore');
const { resolveReleasePublicKey } = require('./license/releaseKey');
const { attachAgentWebSocket } = require('./ws/agentSocket');
const { attachDashboardWebSocket } = require('./ws/dashboardSocket');
const { verifyToken } = require('./auth/jwt');
const { createLicenseManager } = require('./license/licenseManager');
const { createFeatureGate } = require('./license/features');
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
  const enrollmentCodesRepo = createEnrollmentCodesRepository(db);
  const enrollmentStore = createEnrollmentStore(db);
  const agentTokensRepo = createAgentTokensRepository(db);
  const resultsRepo = createResultsRepository(db);
  const probeResultsRepo = createProbeResultsRepository(db);

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
  const releasePublicKey = resolveReleasePublicKey(process.env);

  // Client-side license validation against blueeye-licens. getAgentCount reads
  // the live WebSocket connection count (agentWs is assigned just below; the
  // closure is only invoked later, at validation time).
  let agentWs = null;
  let dashboardWs = null;
  const licenseManager = createLicenseManager({
    config: config.license,
    publicKey: config.license.publicKey,
    cache: createFileCache(config.license.cachePath),
    logger: console,
    getAgentCount: () => (agentWs ? agentWs.connectionCount() : 0),
  });

  // Feature gate: reads signature-verified license entitlements (fail-closed).
  const featureGate = createFeatureGate({ licenseManager });

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

  // Pushes a live event to every connected dashboard (assigned below; the
  // closure runs later). Used for enrollment/agent-status feedback in the UI.
  const notifyDashboard = (message) => (dashboardWs ? dashboardWs.broadcast(message) : 0);

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
      email: createEmailChannel({ config: alertingConfig.channels.email, transport: createSmtpTransport(alertingConfig.channels.email.smtp, console), logger: console }),
      webhook: createWebhookChannel({ config: alertingConfig.channels.webhook, logger: console }),
      syslog: createSyslogChannel({ config: alertingConfig.channels.syslog, logger: console }),
    },
    // Alerting only dispatches if the license includes it.
    licensed: () => featureGate.isFeatureEnabled('alerting'),
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
    alertingEnabled: alertingConfig.enabled,
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
    alertingEnabled: alertingConfig.enabled,
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
  const geoEnricher = createGeoEnricher({ provider: geoProvider, centroids: createCentroids() });
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
    liveAnalysis: analysisConfig, liveRetention: retentionConfig,
  });
  // Re-apply persisted analysis/retention edits onto the live config so they
  // survive restarts. Best-effort + fire-and-forget (consumers read lazily).
  settingsService.applyStoredOverrides().catch((err) => console.warn(`settings: could not apply stored overrides (${err.message})`));
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
    enrollmentCodesRepo,
    enrollmentStore,
    agentTokensRepo,
    resultsRepo,
    probeResultsRepo,
    agentCommander,
    systemInfo,
    licenseManager,
    findingStore,
    analysisPipeline,
    probePipeline,
    flowPipeline,
    flowsRepo,
    geoTileConfig: config.geo,
    assistant,
    dispatcher,
    featureGate,
    settingsService,
    analysisConfig,
    retentionConfig,
    artifactStore,
    agentSourceStore,
    releaseStore: agentReleaseStore,
    releasePublicKey,
    testPackagesRepo,
    testPackageRunner,
    speedtestResultsRepo,
    enrollConfig: { publicUrl: config.publicUrl, certFingerprint: config.enroll.certFingerprint },
    notifyDashboard,
    logger: console,
  });

  const server = app.listen(config.port, () => {
    console.info(
      `blueeye-server listening on port ${config.port} (env: ${config.env})`
    );
  });

  // Live agent channel (WebSocket). New connections are gated by the license
  // (capacity + validity) — this is separate from agent-token authentication.
  agentWs = attachAgentWebSocket({
    server,
    agentTokensRepo,
    agentsRepo,
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
