'use strict';

const { resolvePorts } = require('./ports');
const { createApplicationsRepository } = require('./storage/applicationsRepository');
const { createEnvironmentsRepository } = require('./storage/environmentsRepository');
const { createCredentialsRepository } = require('./storage/credentialsRepository');
const { createAllowedHostsRepository } = require('./storage/allowedHostsRepository');
const { createTestsRepository } = require('./storage/testsRepository');
const { createRunsRepository } = require('./storage/runsRepository');
const { createDiscoveryRepository } = require('./storage/discoveryRepository');
const { createSuggestionsRepository } = require('./storage/suggestionsRepository');
const { createSchedulesRepository } = require('./storage/schedulesRepository');
const { createServiceTestSettingsRepository } = require('./storage/settingsRepository');
const { createWorkersRepository } = require('./storage/workersRepository');
const { createServiceTestSettings } = require('./settings');
const { createServiceTestsApiRouter } = require('./api');
const { createQueue } = require('./scheduler/queue');
const { createArtifactStore, createArtifactRetention } = require('./runner/artifacts');

// Service Tests — the module factory, and the ONLY thing its host constructs.
//
//   const serviceTests = createServiceTestsModule({
//     db, secrets, audit, logger,
//     requireAuth, requireRole, requireFeature,   // host middleware
//     artifactRoot,
//   });
//   router.use('/api/service-tests', serviceTests.router);
//   backgroundJobs.push(...serviceTests.jobs);
//
// Nothing under src/serviceTests/ requires a BlueEye module: db, secrets, audit
// and logger arrive through ports.js, and the auth/licence middleware is passed
// in. Extraction means implementing those against something else — not hunting
// for reach-ins (docs/service-assurance.md §2).
//
// The router is built only when the host supplies auth middleware. A caller that
// wants the storage layer alone (the worker process) simply omits it.
function createServiceTestsModule(rawPorts = {}) {
  const ports = resolvePorts(rawPorts);
  const { db, secrets, audit, logger, clock } = ports;

  const settingsRepo = createServiceTestSettingsRepository({ db });
  const settings = createServiceTestSettings({ repo: settingsRepo });

  const repositories = {
    applications: createApplicationsRepository({ db }),
    environments: createEnvironmentsRepository({ db }),
    credentials: createCredentialsRepository({ db, secretBox: secrets }),
    allowedHosts: createAllowedHostsRepository({ db }),
    tests: createTestsRepository({ db }),
    runs: createRunsRepository({ db, now: clock }),
    discovery: createDiscoveryRepository({ db, now: clock }),
    suggestions: createSuggestionsRepository({ db }),
    schedules: createSchedulesRepository({ db, now: clock }),
    workers: createWorkersRepository({ db, now: clock }),
    settings: settingsRepo,
  };

  // The queue's policy layer. Shared by the API (for "is a worker connected?")
  // and by the worker process itself, so both agree on what stale means.
  const queue = createQueue({
    runsRepo: repositories.runs,
    discoveryRepo: repositories.discovery,
    schedulesRepo: repositories.schedules,
    workersRepo: repositories.workers,
    settings,
    logger,
    now: clock,
  });

  // Screenshot storage. Optional: a deployment with no writable artefact root
  // simply records failures without images rather than failing every run.
  const artifacts = rawPorts.artifactRoot
    ? createArtifactStore({ root: rawPorts.artifactRoot, logger })
    : null;

  const router = rawPorts.requireAuth && rawPorts.requireRole
    ? createServiceTestsApiRouter({
      repositories,
      settings,
      queue,
      artifacts,
      audit,
      logger,
      requireAuth: rawPorts.requireAuth,
      requireRole: rawPorts.requireRole,
      requireFeature: rawPorts.requireFeature || null,
      roles: rawPorts.roles,
    })
    : null;

  // Background jobs the host starts and stops. The RUNNER is not among them —
  // it lives in its own process (scripts/service-test-worker.js), because a
  // Playwright session holds a browser for minutes and must never share a
  // process with the API (spec §23).
  const jobs = [];
  if (artifacts) {
    jobs.push(createArtifactRetention({ runsRepo: repositories.runs, store: artifacts, settings, logger }));
  }

  return { repositories, settings, queue, artifacts, audit, logger, router, jobs };
}

module.exports = { createServiceTestsModule };
