'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { MAX_LIMIT } = require('../coverage/coverageGaps');

// GET /api/coverage — which parts of the network this install does NOT see,
// each gap with the evidence it was decided on and a suggested next step.
// See docs/coverage.md and src/coverage/.
//
// ADMIN ONLY, for the reason the setup checklist is (src/routes/setup.js) and
// more so: this is a list of blind spots. Which sites have no agent, which
// switches nothing can poll, which subnets no agent sits in and which devices
// in the path are unmanaged is precisely the map somebody would want before
// doing something they would rather not be seen doing. It is also only
// actionable by an admin — adding a switch, a credential, a traffic source or
// promoting a discovery candidate are all admin writes.
//
// ?limit=N caps the rows listed PER GAP KIND (1..200, default 50); the summary
// always counts every gap. Anything that is not a whole number in range is a
// 400 rather than a silent default: a caller asking for 1000 rows and getting
// 50 would read the list as complete.
function parseLimit(raw) {
  if (raw === undefined) return { value: undefined };
  const s = Array.isArray(raw) ? null : String(raw).trim();
  if (s == null || !/^[0-9]{1,4}$/.test(s)) return { error: `limit must be a whole number between 1 and ${MAX_LIMIT}` };
  const n = Number(s);
  if (n < 1 || n > MAX_LIMIT) return { error: `limit must be a whole number between 1 and ${MAX_LIMIT}` };
  return { value: n };
}

function createCoverageRouter({ coverageService }) {
  const router = express.Router();

  router.get('/', requireAuth, requireRole(ROLES.ADMIN), asyncHandler(async (req, res) => {
    const limit = parseLimit(req.query.limit);
    if (limit.error) {
      return res.status(400).json({ error: 'Validation failed', details: { limit: limit.error } });
    }
    const report = await coverageService.report({ limit: limit.value });
    return res.json(report);
  }));

  return router;
}

module.exports = { createCoverageRouter };
