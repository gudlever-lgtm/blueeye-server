'use strict';

const { config } = require('./config');
const { createDb } = require('./db');
const { createApp } = require('./app');
const { createLocationsRepository } = require('./repositories/locationsRepository');
const { createUsersRepository } = require('./repositories/usersRepository');
const { createAgentsRepository } = require('./repositories/agentsRepository');
const { createEnrollmentCodesRepository } = require('./repositories/enrollmentCodesRepository');
const { createEnrollmentStore } = require('./services/enrollmentStore');

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
  const app = createApp({
    db,
    locationsRepo,
    usersRepo,
    agentsRepo,
    enrollmentCodesRepo,
    enrollmentStore,
    logger: console,
  });

  const server = app.listen(config.port, () => {
    console.info(
      `blueeye-server listening on port ${config.port} (env: ${config.env})`
    );
  });

  function shutdown(signal) {
    console.info(`Received ${signal}, shutting down gracefully...`);
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
