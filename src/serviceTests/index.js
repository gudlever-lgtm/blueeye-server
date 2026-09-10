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
const { createServiceTestSettings } = require('./settings');

// Service Tests — the module factory, and the ONLY thing its host constructs.
//
// Phase 1 (this commit) builds the storage layer and the settings service. The
// HTTP router and the background jobs arrive in later phases; the shape of the
// return value is fixed now so the mount in src/routes/index.js and the job
// registration in src/server.js are one line each when they land, rather than a
// refactor.
//
//   const serviceTests = createServiceTestsModule({ db, secrets, audit, logger });
//
// Nothing here is wired into BlueEye yet — deliberately. A repository that is
// never constructed is how migration 046's first cut ended up with dead tables in
// production, so the wiring lands in the same commit as the routes that use it.
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
    settings: settingsRepo,
  };

  return {
    repositories,
    settings,
    audit,
    logger,
    // Filled in by later phases: `router` (phase 3-4) and `jobs` (phase 6-11).
    router: null,
    jobs: [],
  };
}

module.exports = { createServiceTestsModule };
