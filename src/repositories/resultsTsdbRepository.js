'use strict';

// TSDB variant of the results repository (docs/storage-split-audit.md). Writes
// land in the TimescaleDB `results` hypertable (agent_id, ts, payload); reads
// use TimescaleDB's last() aggregate.
//
// The read shape matches the MySQL resultsRepository — { agent_id, payload,
// created_at } — so callers and the application-layer join (routes/fleet.js)
// are unchanged when the read path is later switched over.
function createResultsTsdbRepository(tsdb, { latestWindowMinutes = 5 } = {}) {
  const { pool } = tsdb;

  // Bulk-inserts one row per payload at time `at` (default now). `results` is
  // typically 1–5 rows per POST, so a parameterized multi-row INSERT is used;
  // COPY is reserved for the high-fan-out flow ingest. Returns rows inserted.
  async function createMany(agentId, payloads, at) {
    if (!Array.isArray(payloads) || payloads.length === 0) return 0;
    const ts = at instanceof Date ? at : new Date();
    const tuples = [];
    const params = [];
    payloads.forEach((payload, i) => {
      const base = i * 3;
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      params.push(agentId, ts, JSON.stringify(payload));
    });
    const res = await pool.query(
      `INSERT INTO results (agent_id, ts, payload) VALUES ${tuples.join(', ')}`,
      params
    );
    return res.rowCount;
  }

  // The LATEST result per agent across the whole fleet (agents with no result
  // in the window are omitted), for the fleet-health rollup.
  //
  // Punkt 3: last(payload, ts) with a MANDATORY time bound gives constraint
  // exclusion down to the current chunk — never an unbounded GROUP BY on a
  // hypertable. Verified on real TimescaleDB (2 600 agents, 29 ms, one time
  // chunk scanned); see docs/storage-split-audit.md.
  async function latestPerAgent(windowMinutes = latestWindowMinutes) {
    const res = await pool.query(
      `SELECT agent_id,
              last(payload, ts) AS payload,
              last(ts, ts)      AS created_at
       FROM results
       WHERE ts >= now() - make_interval(mins => $1::int)
       GROUP BY agent_id`,
      [windowMinutes]
    );
    // pg parses JSONB into JS objects already; keep the MySQL repo's field names.
    return res.rows.map((row) => ({
      agent_id: row.agent_id,
      payload: row.payload,
      created_at: row.created_at,
    }));
  }

  return { createMany, latestPerAgent };
}

module.exports = { createResultsTsdbRepository };
