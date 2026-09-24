'use strict';

const { numOrNull } = require('../lib/num');

// TSDB variant of the speed-test WRITE path (docs/storage-split-audit.md).
// Rows land in the TimescaleDB `speedtest_results` hypertable
// (server/db/timescale/001_init.sql). Same columns as the MySQL table, minus
// the auto-increment id a hypertable has no use for.
//
// Write-only for now: the mirror half of the dual-write. MySQL stays the source
// of truth and GET /api/speedtest and the fleet overview keep reading there
// until the read cutover.

const COLUMNS = [
  'agent_id', 'ts', 'ok', 'down_mbps', 'up_mbps', 'down_bytes', 'up_bytes',
  'down_ms', 'up_ms', 'target', 'detail',
];

const wholeOrNull = (n) => { const v = numOrNull(n); return v == null ? null : Math.round(v); };

function createSpeedtestResultsTsdbRepository(tsdb) {
  const { pool } = tsdb;

  // Mirrors one validated measurement (validateSpeedtestResult's value).
  // Returns rows inserted (1).
  async function create(agentId, r) {
    const v = r && typeof r === 'object' ? r : {};
    const ts = v.ts instanceof Date ? v.ts : (v.ts ? new Date(v.ts) : new Date());
    const res = await pool.query(
      `INSERT INTO speedtest_results (${COLUMNS.join(', ')})
       VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})`,
      [
        agentId,
        ts,
        v.ok === true,
        v.downMbps ?? null, v.upMbps ?? null,
        // BIGINT in Postgres refuses "1.5" where MySQL rounded silently.
        wholeOrNull(v.downBytes), wholeOrNull(v.upBytes),
        v.downMs ?? null, v.upMs ?? null,
        v.target || null, v.detail || null,
      ],
    );
    return res.rowCount;
  }

  return { create };
}

module.exports = { createSpeedtestResultsTsdbRepository, COLUMNS };
