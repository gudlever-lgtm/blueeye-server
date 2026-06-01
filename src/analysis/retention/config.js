'use strict';

// Retention configuration, read from the same env mechanism as the rest of the
// server. DB hygiene is a safe default, so retention is ON unless disabled.
function toInt(v, d) { const n = Number.parseInt(v, 10); return Number.isNaN(n) ? d : n; }

function loadRetentionConfig(env = process.env) {
  return {
    enabled: env.RETENTION_ENABLED !== 'false',
    rawRetentionDays: toInt(env.RETENTION_RAW_DAYS, 7), // raw/full-resolution kept this long
    rollupRetentionDays: toInt(env.RETENTION_ROLLUP_DAYS, 90), // aggregated kept this long
    findingRetentionDays: toInt(env.RETENTION_FINDING_DAYS, 365), // findings kept longest
    rollupIntervalMinutes: toInt(env.RETENTION_ROLLUP_INTERVAL_MINUTES, 60), // bucket granularity
    intervalHours: toInt(env.RETENTION_JOB_INTERVAL_HOURS, 24), // how often the job runs
    batchSize: toInt(env.RETENTION_BATCH_SIZE, 5000), // rows fetched per rollup page
  };
}

module.exports = { loadRetentionConfig };
