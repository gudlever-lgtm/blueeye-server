'use strict';

const express = require('express');
const { createNis2Context } = require('./_context');
const { createMetaRouter } = require('./meta');
const { createRisksRouter } = require('./risks');
const { createControlsRouter } = require('./controls');
const { createIncidentsRouter } = require('./incidents');
const { createEvidenceRouter } = require('./evidence');
const { createReportsRouter } = require('./reports');
const { createAuditRouter } = require('./audit');
const { createGeneratorRouter } = require('./generator');
const { createExportsRouter } = require('./exports');

// NIS2 Reporting Center API. Mounted at /api/nis2. Reads are viewer+, mutations
// to the register/controls/incidents/evidence are operator+, report approval and
// the audit trail are admin-only. Every create/update/delete is recorded in the
// generic audit log (best-effort — an audit failure never fails the request).
//
// This used to be one 607-line file holding 40 routes across eight unrelated
// resources. They genuinely are unrelated — a risk register and a print-ready
// HTML exporter share a prefix and nothing else — so the file was eight files
// in a trench coat, and the only thing they truly had in common was six helper
// functions. Those now live in _context.js and are built once, here.
//
// Every sub-router keeps its own FULL path ('/risks', '/export/risks.csv', …)
// and is therefore mounted at '/'. That is deliberate: moving the prefix into
// the mount would have meant editing forty route strings, and a refactor whose
// value is "the same routes, in readable files" should not be able to change
// which routes exist. It cannot, this way — and test/gate/security.test.js
// sweeps the whole enumerated surface on every push, so it would say so.
//
// Each sub-router also keeps its own requireAuth on each route, exactly as
// before. Hoisting it here would read better and would almost certainly be
// correct, but "almost certainly" is not the standard for the middleware that
// decides whether a request sees anything at all.
function createNis2Router(deps) {
  const router = express.Router();
  const ctx = createNis2Context(deps);

  for (const create of [
    createMetaRouter,       // /meta, /dashboard
    createRisksRouter,      // /risks…
    createControlsRouter,   // /controls…
    createIncidentsRouter,  // /incidents…, /deadlines
    createEvidenceRouter,   // /evidence…
    createReportsRouter,    // /reports…
    createAuditRouter,      // /audit, /seed
    createGeneratorRouter,  // /custom-reports…
    createExportsRouter,    // /export/*.csv, /export/*.html
  ]) {
    router.use(create(ctx));
  }

  return router;
}

module.exports = { createNis2Router };
