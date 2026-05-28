'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

// GET /health — returns 200 when the database answers, 503 otherwise.
function createHealthRouter({ db }) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      try {
        await db.ping();
      } catch (err) {
        return res.status(503).json({ status: 'error', db: 'down' });
      }
      res.json({ status: 'ok', db: 'up' });
    })
  );

  return router;
}

module.exports = { createHealthRouter };
