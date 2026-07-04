'use strict';

// Integration test for the TSDB results repository against a REAL TimescaleDB.
// Skipped unless TSDB_TEST_URL is set (so the default `npm test` run — and CI
// without a TSDB — stays green). Point it at a database that has had
// server/db/timescale/001_init.sql applied, e.g.:
//
//   TSDB_TEST_URL=postgres://blueeye_tsdb:pw@127.0.0.1:5432/blueeye_telemetry \
//     node --test test/resultsTsdbRepository.integration.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const url = process.env.TSDB_TEST_URL;

test('TSDB results repo: write then latestPerAgent round-trip (real TimescaleDB)', { skip: !url ? 'set TSDB_TEST_URL to run' : false }, async (t) => {
  const { Pool } = require('pg');
  const { createResultsTsdbRepository } = require('../src/repositories/resultsTsdbRepository');

  const pool = new Pool({ connectionString: url });
  t.after(async () => { await pool.end(); });
  const repo = createResultsTsdbRepository({ pool }, { latestWindowMinutes: 5 });

  // Unique agent ids for this run to avoid colliding with other data.
  const a1 = 900001;
  const a2 = 900002;
  await pool.query('DELETE FROM results WHERE agent_id = ANY($1)', [[a1, a2]]);

  // Two payloads for a1 (latest wins), one for a2.
  await repo.createMany(a1, [{ system: { cpuPercent: 10 } }], new Date(Date.now() - 60_000));
  await repo.createMany(a1, [{ system: { cpuPercent: 42 } }], new Date());
  await repo.createMany(a2, [{ system: { cpuPercent: 7 } }], new Date());

  const rows = (await repo.latestPerAgent()).filter((r) => r.agent_id === a1 || r.agent_id === a2);
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));

  assert.equal(byAgent[a1].payload.system.cpuPercent, 42); // latest, not 10
  assert.equal(byAgent[a2].payload.system.cpuPercent, 7);
  assert.ok(byAgent[a1].created_at instanceof Date);

  // An agent with no telemetry in the window is simply absent (fleet renders null).
  assert.equal(rows.find((r) => r.agent_id === 999999), undefined);

  await pool.query('DELETE FROM results WHERE agent_id = ANY($1)', [[a1, a2]]);
});
