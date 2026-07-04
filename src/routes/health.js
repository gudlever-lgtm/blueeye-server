'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

// GET /health — 200 when the datastores answer, 503 otherwise. Always checks
// MySQL; also checks TimescaleDB when the telemetry store is enabled (tsdb
// injected), so the storage-split deploy has a real TSDB-backed health probe.
function createHealthRouter({ db, tsdb = null }) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      try {
        await db.ping();
      } catch (err) {
        return res.status(503).json({ status: 'error', db: 'down' });
      }
      if (tsdb) {
        try {
          await tsdb.ping();
        } catch (err) {
          return res.status(503).json({ status: 'error', db: 'up', tsdb: 'down' });
        }
        return res.json({ status: 'ok', db: 'up', tsdb: 'up' });
      }
      res.json({ status: 'ok', db: 'up' });
    })
  );

  return router;
}

module.exports = { createHealthRouter };
