'use strict';

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth } = require('../../auth/middleware');
const { computeDashboard } = require('../../nis2/dashboard');
const { CATEGORIES } = require('../../nis2/constants');

// The vocabulary the dashboard builds its forms from, and the readiness
// dashboard itself. Both are pure reads over the three registers.
function createMetaRouter(ctx) {
  const router = express.Router();
  const { reader, loadAll } = ctx;

  // ---- Meta -----------------------------------------------------------------

  // The category vocabulary — lets the dashboard build its forms without
  // hard-coding the enum twice.
  router.get('/meta', requireAuth, reader, (req, res) => {
    res.json({ categories: CATEGORIES });
  });

  // ---- Dashboard ------------------------------------------------------------

  router.get('/dashboard', requireAuth, reader, asyncHandler(async (req, res) => {
    const data = await loadAll();
    res.json(computeDashboard(data));
  }));

  return router;
}

module.exports = { createMetaRouter };
