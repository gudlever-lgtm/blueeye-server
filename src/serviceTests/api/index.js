'use strict';

const express = require('express');
const { createApplicationsRouter } = require('./applications');
const { createTestsRouter } = require('./tests');
const { createRunsRouter } = require('./runs');
const { createDiscoveryRouter } = require('./discovery');
const { createSchedulesRouter } = require('./schedules');
const { createSettingsRouter } = require('./settings');
const { createAssuranceRouter } = require('./assurance');

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
  artifacts = null,
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

  const deps = { repositories, settings, queue, reactor, artifacts, audit, logger, requireRole, roles };

  router.use('/applications', createApplicationsRouter(deps));
  router.use('/tests', createTestsRouter(deps));
  router.use('/runs', createRunsRouter(deps));
  router.use('/discovery', createDiscoveryRouter(deps));
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
