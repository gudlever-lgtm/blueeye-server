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
const { attachAgentWebSocket } = require('./ws/agentSocket');
const { createLicenseManager } = require('./license/licenseManager');
const { createFileCache } = require('./license/licenseCache');
const { isConfigured } = require('./license/publicKey');
const { createSystemInfo } = require('./services/systemInfo');

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

  // Client-side license validation against blueeye-licens. getAgentCount reads
  // the live WebSocket connection count (agentWs is assigned just below; the
  // closure is only invoked later, at validation time).
  let agentWs = null;
  const licenseManager = createLicenseManager({
    config: config.license,
    publicKey: config.license.publicKey,
    cache: createFileCache(config.license.cachePath),
    logger: console,
    getAgentCount: () => (agentWs ? agentWs.connectionCount() : 0),
  });

  // Lets HTTP routes push commands to connected agents over the WebSocket.
  const agentCommander = {
    sendCommand: (agentId, command) => (agentWs ? agentWs.sendCommand(agentId, command) : 0),
  };

  // Storage info (disk free/used + database size).
  const systemInfo = createSystemInfo({ db, diskPath: config.storage.diskPath });

  const app = createApp({
    db,
    locationsRepo,
    usersRepo,
    agentsRepo,
    enrollmentCodesRepo,
    enrollmentStore,
    agentTokensRepo,
    resultsRepo,
    agentCommander,
    systemInfo,
    licenseManager,
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
  });

  if (!isConfigured(config.license.publicKey)) {
    console.warn(
      'License public key is not configured (placeholder) — proofs cannot be verified and agents will not be licensed. See src/license/publicKey.js.'
    );
  }
  // Validate at startup, then periodically. Failures fall back to cache + grace.
  licenseManager.start().catch((err) => console.error('License manager error:', err));

  function shutdown(signal) {
    console.info(`Received ${signal}, shutting down gracefully...`);
    licenseManager.stop();
    agentWs.close();
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
