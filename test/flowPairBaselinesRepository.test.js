'use strict';

// flowPairBaselinesRepository — the pair filter and the "last complete hour"
// read the flow-pair baseline context uses (GET /api/baselines/flow-pair).
// Scripted pool: asserts the statement and its parameters; whether the SQL runs
// on MySQL is scripts/verify-repositories-against-mysql.js's question.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFlowPairBaselinesRepository } = require('../src/repositories/flowPairBaselinesRepository');

function fakePool(rows) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return [rows]; } };
}

test('listForHost keeps its host-only statement when no pair is named', async () => {
  const pool = fakePool([]);
  await createFlowPairBaselinesRepository({ pool }).listForHost({ hostId: 7, limit: 10 });
  assert.match(pool.calls[0].sql, /WHERE src_host_id = \?\s+ORDER BY/);
  assert.deepEqual(pool.calls[0].params, [7, 10]);
});

test('listForHost narrows to one pair with bound parameters', async () => {
  const pool = fakePool([]);
  await createFlowPairBaselinesRepository({ pool }).listForHost({ hostId: 7, dstHostId: 9, dstPort: 443 });
  assert.match(pool.calls[0].sql, /src_host_id = \? AND dst_host_id = \? AND dst_port = \?/);
  assert.deepEqual(pool.calls[0].params, [7, 9, 443, 500]);
});

test('latestHourlyForHost takes the latest bucket over the SAME filter and maps the rows', async () => {
  const pool = fakePool([{ src_host_id: 7, dst_host_id: 9, dst_port: 443, proto: 'tcp', bucket: new Date('2026-09-22T14:00:00Z'), bytes: '2200', packets: 3, conn_count: 1 }]);
  const rows = await createFlowPairBaselinesRepository({ pool }).latestHourlyForHost({ hostId: 7, dstHostId: 9, dstPort: 443 });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /FROM flow_pair_hourly\s+WHERE src_host_id = \? AND dst_host_id = \? AND dst_port = \? AND bucket = \(SELECT MAX\(bucket\) FROM flow_pair_hourly WHERE src_host_id = \? AND dst_host_id = \? AND dst_port = \?\)/);
  assert.deepEqual(params, [7, 9, 443, 7, 9, 443, 5000]);
  assert.deepEqual(rows, [{ srcHostId: 7, dstHostId: 9, dstPort: 443, proto: 'tcp', bucket: '2026-09-22T14:00:00.000Z', bytes: 2200, packets: 3, connCount: 1 }]);
});

test('latestHourlyForHost clamps an out-of-range limit', async () => {
  const pool = fakePool([]);
  await createFlowPairBaselinesRepository({ pool }).latestHourlyForHost({ hostId: 7, limit: 999999 });
  assert.deepEqual(pool.calls[0].params, [7, 7, 5000]);
});
