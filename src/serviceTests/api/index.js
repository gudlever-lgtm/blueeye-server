'use strict';

const express = require('express');
const { createApplicationsRouter } = require('./applications');
const { createTestsRouter } = require('./tests');
const { createRunsRouter } = require('./runs');
const { createStatsRouter } = require('./stats');
const { createDiscoveryRouter } = require('./discovery');
const { createSchedulesRouter } = require('./schedules');
const { createSettingsRouter } = require('./settings');
const { createAssuranceRouter } = require('./assurance');
const { createRecordingsRouter } = require('./recordings');
const { createJourneysRouter } = require('./journeys');
const { createHealingRouter } = require('./healing');
const { createMapRouter } = require('./map');
const { createAnalysisRouter } = require('./analysis');
const { createBaselinesRouter } = require('./baselines');

// The Service Tests HTTP surface, mounted at /api/service-tests.
//
// Two layers of access control, as agreed (docs/service-assurance.md §8):
//   * the LICENCE decides whether the module exists at all — one gate on the
//     whole mount, so there is no route to forget;
//   * RBAC decides who may do what inside it — declared per route.
//
// `requireFeature` and the role middlewares are INJECTED rather than required
// from BlueEye, so the module keeps its extraction boundary: a standalone
// deployment supplies its own, or a pass-through.
function createServiceTestsApiRouter({
  repositories,
  settings,
  queue,
  // The reaction loop. Present in the API process, absent in the worker — so the
  // router degrades to read-only incident/certificate views rather than failing
  // to build.
  reactor = null,
  // The AI assistance layer. Always present as an object; `null` would make
  // every call site test for it, and the layer already answers "unavailable,
  // because…" for the deployments that have no provider — which is most of them.
  aiAnalysis = null,
  artifacts = null,
  // Returns public/recorder.js as a string, so the bookmarklet can carry the
  // recorder inline and survive the target site's Content-Security-Policy.
  recorderSource = null,
  // The address a CUSTOMER'S browser must use to reach this server. Not the
  // address it listens on: behind a proxy those differ, and the bookmarklet
  // needs the outside one or the recorder cannot call home.
  publicUrl = null,
  audit = null,
  logger = null,
  // Middleware supplied by the host.
  requireAuth,
  requireRole,
  requireFeature = null,
  roles = { VIEWER: 'viewer', OPERATOR: 'operator', ADMIN: 'admin' },
}) {
  const router = express.Router();

  // Order matters: authenticate FIRST so an anonymous request answers 401 and
  // never leaks the licence state, THEN gate on the licence so a signed-in user
  // on an unlicensed install gets one clear 403 from every path.
  if (requireAuth) router.use(requireAuth);
  if (requireFeature) router.use(requireFeature);

  const deps = { repositories, settings, queue, reactor, aiAnalysis, artifacts, audit, logger, requireRole, roles, recorderSource, publicUrl };

  router.use('/applications', createApplicationsRouter(deps));
  router.use('/tests', createTestsRouter(deps));
  router.use('/runs', createRunsRouter(deps));
  // Read-only aggregation over the same runs, for the history charts.
  router.use('/stats', createStatsRouter(deps));
  // User Journeys — the central V2 object. Mounted before discovery so the
  // route table reads in the order the product does: what the service IS, then
  // how it is found out.
  router.use('/journeys', createJourneysRouter(deps));
  // Self-healing proposals. A separate mount because deciding one is a
  // different act from running a test: it CHANGES a test, and the spec insists
  // that only ever happens with an operator's accept.
  router.use('/healing', createHealingRouter(deps));
  // Visual regression baselines. Accepting one is an ACT — a picture captured
  // automatically on first sight would be a baseline of whatever the page
  // happened to look like that day, including broken.
  router.use('/baselines', createBaselinesRouter(deps));
  // The service map: application → journey → page → API → endpoint, computed on
  // read from what runs observed. Read-only — the moment it can be edited it is
  // a CMDB, which is exactly what the spec says it must not become.
  router.use('/map', createMapRouter(deps));
  // The V3 intelligence layer: why a run failed, whether an incident is new,
  // what a service depends on, how healthy it is, what looks out of the
  // ordinary. Computed on read — none of it is stored, so an analysis can never
  // be more stale than its evidence.
  router.use('/analysis', createAnalysisRouter(deps));
  router.use('/discovery', createDiscoveryRouter(deps));
  // Recording. The INGEST half is not here: it carries no session, so the host
  // mounts it outside this router (src/serviceTests/index.js).
  router.use('/recordings', createRecordingsRouter(deps));
  router.use('/suggestions', createDiscoveryRouter.suggestions(deps));
  router.use('/schedules', createSchedulesRouter(deps));
  router.use('/settings', createSettingsRouter(deps));
  // What is currently wrong, and every certificate the module watches.
  router.use('/assurance', createAssuranceRouter(deps));

  // Environments and credentials are nested under an application in the UI, but
  // a flat list is what the spec's API section asks for, so both exist.
  router.use('/environments', createApplicationsRouter.environments(deps));
  router.use('/credentials', createApplicationsRouter.credentials(deps));

  return router;
}

module.exports = { createServiceTestsApiRouter };
