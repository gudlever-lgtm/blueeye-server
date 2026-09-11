'use strict';

const express = require('express');
const { asyncHandler, invalid } = require('./helpers');
const { validateStatsQuery } = require('../validation');
const { resolvePeriod } = require('../stats/period');

// GET /api/service-tests/stats — the run history as a chart, not a list.
//
//   ?period=day|week|month|year   which segmentation (default: week)
//   &at=YYYY-MM-DD                any date inside the wanted period (default: now)
//   &tz_offset=-120               the viewer's getTimezoneOffset()
//   &test_id= / &application_id=  narrow it; omit both for the whole install
//
// Read-only and viewer+, like every other read here. The response carries the
// previous and next period, so the dashboard's ◀ ▶ buttons never do calendar
// arithmetic of their own — one definition of "last month", on the server.
function createStatsRouter({ repositories, requireRole, roles, now = () => new Date() }) {
  const router = express.Router();
  const { runs, tests, applications } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);

  router.get('/', read, asyncHandler(async (req, res) => {
    const { value, errors } = validateStatsQuery(req.query);
    if (errors) return invalid(res, errors);

    // A chart for a test that does not exist is a 404, not an empty chart: an
    // empty chart says "nothing ran", which is a different fact.
    if (value.test_id !== undefined) {
      const test = await tests.findById(value.test_id);
      if (!test) return res.status(404).json({ error: 'Test not found' });
    }
    if (value.application_id !== undefined) {
      const app = await applications.findById(value.application_id);
      if (!app) return res.status(404).json({ error: 'Application not found' });
    }

    const period = resolvePeriod({
      period: value.period,
      at: value.at,
      offsetMinutes: value.tz_offset,
      now: now(),
    });

    const rows = await runs.stats({
      from: period.from,
      to: period.to,
      sqlFormat: period.sql_format,
      offsetMinutes: period.offset_minutes,
      testId: value.test_id ?? null,
      applicationId: value.application_id ?? null,
    });

    // Every bucket in the period, empty ones included — a gap in the bars is the
    // reading an operator needs ("it stopped running on Thursday"), and it only
    // exists if the empty buckets are in the answer.
    const byBucket = new Map(rows.map((r) => [r.bucket, r]));
    const buckets = period.buckets.map((b) => {
      const row = byBucket.get(b.key);
      return {
        start: b.start,
        key: b.key,
        total: row ? row.total : 0,
        pass: row ? row.pass : 0,
        fail: row ? row.fail : 0,
        warning: row ? row.warning : 0,
        error: row ? row.error : 0,
        skipped: row ? row.skipped : 0,
        avg_duration_ms: row ? row.avg_duration_ms : null,
        max_duration_ms: row ? row.max_duration_ms : null,
      };
    });

    const sum = (key) => buckets.reduce((acc, b) => acc + b[key], 0);
    const total = sum('total');
    // Averaged over RUNS, not over buckets: a bucket with 400 runs and one with
    // 2 must not weigh the same.
    const weighted = buckets.reduce(
      (acc, b) => (b.avg_duration_ms === null ? acc : { ms: acc.ms + b.avg_duration_ms * b.total, n: acc.n + b.total }),
      { ms: 0, n: 0 }
    );

    return res.json({
      period: period.period,
      bucket: period.bucket,
      at: period.at,
      from: period.from,
      to: period.to,
      prev_at: period.prev_at,
      next_at: period.next_at,
      has_next: period.has_next,
      is_current: period.is_current,
      test_id: value.test_id ?? null,
      application_id: value.application_id ?? null,
      buckets,
      totals: {
        total,
        pass: sum('pass'),
        fail: sum('fail'),
        warning: sum('warning'),
        error: sum('error'),
        skipped: sum('skipped'),
        // Null rather than 100% when nothing ran: no runs is not a perfect score.
        success_rate: total ? sum('pass') / total : null,
        avg_duration_ms: weighted.n ? Math.round(weighted.ms / weighted.n) : null,
        max_duration_ms: buckets.reduce((acc, b) => (b.max_duration_ms === null ? acc : Math.max(acc, b.max_duration_ms)), 0) || null,
      },
    });
  }));

  return router;
}

module.exports = { createStatsRouter };
