'use strict';

// Integration test for the flow / probe / speed-test TSDB mirrors against a
// REAL TimescaleDB. Skipped unless TSDB_TEST_URL is set (so the default
// `npm test` run — and CI without a TSDB — stays green), exactly like
// resultsTsdbRepository.integration.test.js. Point it at a database that has
// had server/db/timescale/001_init.sql applied, e.g.:
//
//   TSDB_TEST_URL=postgres://blueeye_tsdb:pw@127.0.0.1:5432/blueeye_telemetry \
//     node --test test/telemetryTsdbRepositories.integration.test.js
//
// What only a real server can say: that the unnest() array casts, the JSONB
// params and the column list are valid SQL against the hypertables as created.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const url = process.env.TSDB_TEST_URL;
const skip = !url ? 'set TSDB_TEST_URL to run' : false;

// Unique agent id for this run to avoid colliding with other data.
const AGENT = 900101;

async function withPool(t) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url });
  t.after(async () => { await pool.end(); });
  return pool;
}

test('TSDB flow_records mirror: a batch round-trips through unnest()', { skip }, async (t) => {
  const pool = await withPool(t);
  const { createFlowsTsdbRepository } = require('../src/repositories/flowsTsdbRepository');
  const repo = createFlowsTsdbRepository({ pool });
  await pool.query('DELETE FROM flow_records WHERE agent_id = $1', [AGENT]);

  const ts = new Date();
  const n = await repo.insertMany([
    { agentId: AGENT, ts, srcIp: '10.0.0.5', dstIp: '8.8.8.8', extIp: '8.8.8.8', direction: 'out', proto: 'udp', srcPort: 5353, dstPort: 53, bytes: 120, packets: 2, flows: 1, internal: false, country: 'US', asn: 15169, asnName: 'Google' },
    { agentId: AGENT, ts, srcIp: '10.0.0.5', dstIp: '10.0.0.9', direction: 'out', proto: 'tcp', srcPort: 50000, dstPort: 502, bytes: 64, packets: 1, flows: 1, internal: true },
  ]);
  assert.equal(n, 2);
  const { rows } = await pool.query('SELECT dst_port, internal, country FROM flow_records WHERE agent_id = $1 ORDER BY dst_port', [AGENT]);
  assert.deepEqual(rows.map((r) => [r.dst_port, r.internal, r.country]), [[53, false, 'US'], [502, true, null]]);
  await pool.query('DELETE FROM flow_records WHERE agent_id = $1', [AGENT]);
});

test('TSDB probe_results mirror: every column, JSONB included, round-trips', { skip }, async (t) => {
  const pool = await withPool(t);
  const { createProbeResultsTsdbRepository } = require('../src/repositories/probeResultsTsdbRepository');
  const repo = createProbeResultsTsdbRepository({ pool });
  await pool.query('DELETE FROM probe_results WHERE agent_id = $1', [AGENT]);

  const n = await repo.createMany(AGENT, [
    { type: 'traceroute', target: '1.1.1.1', ok: true, hops: [{ hop: 1, ip: '10.0.0.1', rttMs: 1.2 }] },
    { type: 'dns', target: 'example.org', ok: false, errorCode: 'ENOTFOUND', failure: 'nxdomain', resolver: '10.0.0.53' },
  ]);
  assert.equal(n, 2);
  const { rows } = await pool.query('SELECT type, ok, hops, error_code FROM probe_results WHERE agent_id = $1 ORDER BY type', [AGENT]);
  assert.equal(rows[0].type, 'dns');
  assert.equal(rows[0].error_code, 'ENOTFOUND');
  assert.equal(rows[1].ok, true);
  assert.equal(rows[1].hops[0].ip, '10.0.0.1');
  await pool.query('DELETE FROM probe_results WHERE agent_id = $1', [AGENT]);
});

test('TSDB speedtest_results mirror: one measurement round-trips', { skip }, async (t) => {
  const pool = await withPool(t);
  const { createSpeedtestResultsTsdbRepository } = require('../src/repositories/speedtestResultsTsdbRepository');
  const repo = createSpeedtestResultsTsdbRepository({ pool });
  await pool.query('DELETE FROM speedtest_results WHERE agent_id = $1', [AGENT]);

  assert.equal(await repo.create(AGENT, { ok: true, downMbps: 120.5, upMbps: 40, downBytes: 1000, upBytes: 1000, downMs: 66, upMs: 200, target: 'srv' }), 1);
  const { rows } = await pool.query('SELECT ok, down_mbps, target FROM speedtest_results WHERE agent_id = $1', [AGENT]);
  assert.deepEqual(rows.map((r) => [r.ok, r.down_mbps, r.target]), [[true, 120.5, 'srv']]);
  await pool.query('DELETE FROM speedtest_results WHERE agent_id = $1', [AGENT]);
});
