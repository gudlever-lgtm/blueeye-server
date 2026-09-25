'use strict';

const express = require('express');
const { createAgentsContext } = require('./_context');
const { createAgentReleasesRouter } = require('./releases');
const { createAgentCommandsRouter } = require('./commands');
const { createFleetUpdateRouter } = require('./fleetUpdate');
const { createAgentCrudRouter } = require('./crud');
const { aggregateFlows } = require('./flows');

// Agents router with role-based access control:
//   - viewer+        may read         (GET)
//   - operator/admin may edit metadata (PUT — server-managed fields only)
//   - admin          may delete       (DELETE)
//
// Agents are created via enrollment — there is intentionally no manual
// POST /agents here.
//
// This was one 855-line file. The nineteen routes under /agents do three
// different jobs that only share a prefix:
//
//   crud       the agent RECORD — list it, edit its metadata, delete it, read
//              what it reported. Ordinary CRUD over a table.
//   commands   what the server PUSHES down the agent's socket — update, delete,
//              rekey, install-tool, probes. These change a customer's host, and
//              they are why the audit trail and the command signer exist.
//   releases   the signed artefacts those commands install.
//   fleet      the same update, selected and paced across many agents at once.
//
// Reading the update path used to mean scrolling past the flow aggregator.
//
// Mount ORDER is load-bearing. The commands router owns literal sub-paths
// (/:id/update, /:id/rekey, …) and the CRUD router owns PUT/DELETE /:id — those
// cannot collide, since the literals are longer. But /releases is a POST to a
// literal path, and it MUST stay ahead of anything that could read `releases`
// as an :id. It is first for that reason, not by accident.
function createAgentsRouter(deps) {
  const router = express.Router();
  const ctx = createAgentsContext(deps);

  router.use(createAgentReleasesRouter(ctx));
  // Literal '/updates/fleet', so it goes ahead of anything that could read
  // 'updates' as an :id — the same reason /releases is first.
  router.use(createFleetUpdateRouter(ctx));
  router.use(createAgentCommandsRouter(ctx));
  router.use(createAgentCrudRouter(ctx));

  return router;
}

// Re-exported because the flow tests import it from here, and because moving a
// pure helper should not be a breaking change for a caller.
module.exports = { createAgentsRouter, aggregateFlows };
