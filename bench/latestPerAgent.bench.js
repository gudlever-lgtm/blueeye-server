'use strict';

// Benchmark for the Punkt 3 latestPerAgent query against a REAL TimescaleDB
// (docs/storage-split-audit.md). Seeds N agents with historical + recent
// telemetry, runs EXPLAIN ANALYZE to confirm chunk-exclusion, and measures
// query latency.
//
// Requires TSDB_TEST_URL pointed at a database with
// server/db/timescale/001_init.sql applied. Not part of `npm test`.
//
//   TSDB_TEST_URL=postgres://blueeye_tsdb:pw@127.0.0.1:5432/blueeye_telemetry \
//     AGENTS=2600 node bench/latestPerAgent.bench.js
//
// Target: < 50 ms for 2 600 agents; EXPLAIN must show ChunkAppend over the
// current time chunk only (never a scan across all chunks).

const { Pool } = require('pg');

const url = process.env.TSDB_TEST_URL;
if (!url) {
  console.error('set TSDB_TEST_URL to run this benchmark');
  process.exit(2);
}
const AGENTS = Number.parseInt(process.env.AGENTS || '2600', 10);
const HISTORY_HOURS = Number.parseInt(process.env.HISTORY_HOURS || '24', 10);
const BASE = 800000; // benchmark agent_id namespace, cleaned up after

async function main() {
  const pool = new Pool({ connectionString: url });
  try {
    console.log(`seeding ${AGENTS} agents × ${HISTORY_HOURS}h history + 1 recent row each…`);
    await pool.query('DELETE FROM results WHERE agent_id >= $1 AND agent_id < $2', [BASE, BASE + AGENTS + 1]);

    // Historic rows across many chunks (excluded by the 5-minute window).
    await pool.query(
      `INSERT INTO results (agent_id, ts, payload)
       SELECT $1 + g, now() - (h || ' hours')::interval,
              jsonb_build_object('system', jsonb_build_object('cpuPercent',(random()*100)::numeric(5,2)))
       FROM generate_series(1,$2) g, generate_series(1,$3) h`,
      [BASE, AGENTS, HISTORY_HOURS]
    );
    // One fresh row per agent within the last 2 minutes (current chunk).
    await pool.query(
      `INSERT INTO results (agent_id, ts, payload)
       SELECT $1 + g, now() - (random()*120 || ' seconds')::interval,
              jsonb_build_object('system', jsonb_build_object('cpuPercent',(random()*100)::numeric(5,2)))
       FROM generate_series(1,$2) g`,
      [BASE, AGENTS]
    );

    const q = `SELECT agent_id, last(payload, ts) AS payload, last(ts, ts) AS last_ts
               FROM results
               WHERE ts >= now() - INTERVAL '5 minutes'
               GROUP BY agent_id`;

    const plan = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) ${q}`);
    const planText = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    const chunkAppend = /ChunkAppend/.test(planText);
    const distinctChunks = new Set(planText.match(/_hyper_\d+_\d+_chunk/g) || []).size;
    console.log('\n--- EXPLAIN ---\n' + planText + '\n');

    // Timed runs (median of 5).
    const times = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = process.hrtime.bigint();
      const res = await pool.query(q);
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0) / 1e6);
      if (i === 0) console.log(`rows returned: ${res.rowCount}`);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];

    console.log(`\nlatency (median of 5): ${median.toFixed(1)} ms`);
    console.log(`distinct chunks scanned: ${distinctChunks} (current time chunk × space partitions)`);
    console.log(`ChunkAppend present: ${chunkAppend}`);
    console.log(median < 50 ? 'PASS: under 50 ms target' : 'WARN: over 50 ms target');
  } finally {
    await pool.query('DELETE FROM results WHERE agent_id >= $1 AND agent_id < $2', [BASE, BASE + AGENTS + 1]).catch(() => {});
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
