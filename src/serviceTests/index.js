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
const { createCertificatesRepository } = require('./storage/certificatesRepository');
const { createIncidentsRepository } = require('./storage/incidentsRepository');
const { createRecordingsRepository } = require('./storage/recordingsRepository');
const { createJourneysRepository } = require('./storage/journeysRepository');
const { createHealingRepository } = require('./storage/healingRepository');
const { createServiceTestSettings } = require('./settings');
const { createServiceTestsApiRouter } = require('./api');
const { createQueue } = require('./scheduler/queue');
const { createArtifactStore, createArtifactRetention } = require('./runner/artifacts');
const { createAssuranceReactor, createAssuranceJob } = require('./assurance/reactor');
const { createRecordingsCaptureRouter } = require('./api/recordings');
const { createRecordingRetention } = require('./recording/retention');
const { createRecorderSource } = require('./recording/bookmarklet');

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
    certificates: createCertificatesRepository({ db, now: clock }),
    incidents: createIncidentsRepository({ db, now: clock }),
    recordings: createRecordingsRepository({ db, now: clock }),
    journeys: createJourneysRepository({ db, now: clock }),
    healing: createHealingRepository({ db, now: clock }),
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

  // The reaction loop — certificates watched on their own schedule, failing tests
  // counted into incidents, alerts sent on a state change. Built only where it
  // can run: the API process wires `notify` to the alerting dispatcher, and the
  // worker process (which passes no auth middleware) never starts a sweep.
  const reactor = rawPorts.requireAuth && rawPorts.requireRole
    ? createAssuranceReactor({
      repositories,
      settings,
      certificateChecker: rawPorts.certificateChecker || null,
      notify: rawPorts.notify || null,
      logger,
      now: clock,
    })
    : null;

  // The ingest half of Recording. It wears NO session middleware — the capture
  // token is its whole authority (src/serviceTests/api/recordings.js explains
  // why that is the design and not a gap) — so the host mounts it outside the
  // authenticated mount. Built only where the authenticated half is, because a
  // capture token can only exist if an operator started a recording there.
  const captureRouter = rawPorts.requireAuth && rawPorts.requireRole
    ? createRecordingsCaptureRouter({ repositories, logger, rateLimit: rawPorts.captureRateLimit || null })
    : null;

  // The browser-side recorder's source, read from the path the host gives us.
  // The bookmarklet carries it INLINE, because a bookmarklet's own code is
  // exempt from the target site's CSP while a <script src> it appends is not.
  const recorderSource = createRecorderSource({ path: rawPorts.recorderScriptPath || null, logger });

  const router = rawPorts.requireAuth && rawPorts.requireRole
    ? createServiceTestsApiRouter({
      repositories,
      settings,
      queue,
      reactor,
      artifacts,
      audit,
      logger,
      recorderSource,
      publicUrl: rawPorts.publicUrl || null,
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
  // The sweep IS a background job, unlike the runner: it needs no browser, so it
  // belongs in the API process where the alerting configuration lives.
  if (reactor) jobs.push(createAssuranceJob({ reactor, settings, logger }));
  // Abandoned recordings are swept rather than kept: an expired one is dead
  // weight, and it is whatever the operator typed before they wandered off.
  if (captureRouter) jobs.push(createRecordingRetention({ recordingsRepo: repositories.recordings, logger }));

  return { repositories, settings, queue, artifacts, reactor, audit, logger, router, captureRouter, jobs };
}

module.exports = { createServiceTestsModule };
