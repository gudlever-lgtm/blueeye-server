'use strict';

// SQL shape of the retention repository's newer statements, against a scripted
// pool. Whether MySQL accepts them is verify-schema's question; what is pinned
// here is WHICH rows each purge may touch, because that is the part a careless
// edit turns into data loss.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRetentionRepo, INTERNAL_FLOW_ROLLUP_COLS } = require('../src/analysis/retention/repo');

function scriptedPool(affected = 0) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^SELECT/i.test(sql.trim())) return [[]];
      return [{ affectedRows: affected }];
    },
  };
}

const CUT = new Date('2026-01-01T00:00:00Z');

test('discovered devices: a PROMOTED row is never purged, only discovered/ignored ones gone stale', async () => {
  const pool = scriptedPool();
  await createRetentionRepo({ pool }).purgeStaleDiscoveredDevicesBefore(CUT);
  const { sql, params } = pool.queries[0];
  assert.match(sql, /^DELETE FROM discovered_devices WHERE status IN \('discovered', 'ignored'\) AND last_seen < \? ORDER BY last_seen LIMIT \?$/);
  assert.doesNotMatch(sql, /promoted/);
  assert.equal(params[0], CUT);
});

test('probe outages: an OPEN outage is never purged', async () => {
  const pool = scriptedPool();
  await createRetentionRepo({ pool }).purgeResolvedProbeOutagesBefore(CUT);
  assert.match(pool.queries[0].sql, /WHERE resolved_at IS NOT NULL AND resolved_at < \?/);
});

test('audit: the purge touches audit_events on last_seen_at, never the hash-chained audit_log', async () => {
  const pool = scriptedPool();
  await createRetentionRepo({ pool }).purgeAuditEventsBefore(CUT);
  assert.match(pool.queries[0].sql, /^DELETE FROM audit_events WHERE last_seen_at < \?/);
  const repo = createRetentionRepo({ pool });
  assert.ok(!Object.keys(repo).some((k) => /auditlog/i.test(k)), 'no audit_log purge may exist');
});

test('measurement tables age out on their own timestamp column, in batches', async () => {
  const pool = scriptedPool();
  const repo = createRetentionRepo({ pool });
  await repo.purgeProbeResultsBefore(CUT);
  await repo.purgeSpeedtestResultsBefore(CUT);
  await repo.purgeTransactionResultsBefore(CUT);
  await repo.purgeTopologyChangesBefore(CUT);
  await repo.purgeHostConnectionsBefore(CUT);
  await repo.purgeInternalFlowRollupsBefore(CUT);
  const sqls = pool.queries.map((q) => q.sql);
  assert.match(sqls[0], /^DELETE FROM probe_results WHERE ts < \? ORDER BY ts LIMIT \?$/);
  assert.match(sqls[1], /^DELETE FROM speedtest_results WHERE ts < \? ORDER BY ts LIMIT \?$/);
  assert.match(sqls[2], /^DELETE FROM transaction_results WHERE `time` < \? ORDER BY `time` LIMIT \?$/);
  assert.match(sqls[3], /^DELETE FROM topology_changes WHERE detected_at < \?/);
  assert.match(sqls[4], /^DELETE FROM host_connections WHERE last_seen < \?/);
  assert.match(sqls[5], /^DELETE FROM flow_internal_rollup WHERE bucket < \?/);
  for (const q of pool.queries) assert.equal(q.params[q.params.length - 1], 10000); // the batch size
});

test('a purge keeps deleting in batches until a short batch', async () => {
  let calls = 0;
  const pool = { async query() { calls += 1; return [{ affectedRows: calls < 3 ? 10000 : 7 }]; } };
  assert.equal(await createRetentionRepo({ pool }).purgeProbeResultsBefore(CUT), 20007);
  assert.equal(calls, 3);
});

test('internal flows are read with both ports, internal rows only; the rollup upsert sums', async () => {
  const pool = scriptedPool(1);
  const repo = createRetentionRepo({ pool });
  await repo.getRawInternalFlowsBatch(CUT, 5, 100);
  assert.match(pool.queries[0].sql, /SELECT id, agent_id, ts, src_ip, dst_ip, proto, src_port, dst_port, bytes, packets, flows FROM flow_records WHERE internal = 1 AND ts < \? AND id > \?/);
  assert.deepEqual(pool.queries[0].params, [CUT, 5, 100]);
  await repo.insertInternalFlowRollups([[CUT, 9, '10.0.0.1', '10.0.0.2', 'tcp', 502, 10, 1, 1]]);
  const ins = pool.queries[1].sql;
  assert.match(ins, new RegExp(`^INSERT INTO flow_internal_rollup \\(${INTERNAL_FLOW_ROLLUP_COLS.join(', ')}\\) VALUES \\?`));
  assert.match(ins, /bytes = bytes \+ VALUES\(bytes\)/);
  assert.equal(await repo.insertInternalFlowRollups([]), 0);
});
