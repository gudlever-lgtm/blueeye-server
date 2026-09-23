-- 121 — indexes for the retention purges added alongside it.
--
-- The retention job now also ages out probe_results, speedtest_results,
-- transaction_results, closed probe_outages, topology_changes, stale
-- discovered_devices, host_connections and audit_events (see
-- docs/retention.md). Each purge is a batched `DELETE ... WHERE <ts> < ? ORDER
-- BY <ts> LIMIT ?`, which without an index on <ts> is a full scan per batch on
-- what are some of the largest tables in the schema.
--
-- Most already have one: probe_results.ts (idx_probe_ts), probe_outages.
-- resolved_at, topology_changes.detected_at, discovered_devices (status,
-- last_seen), host_connections.last_seen and audit_events.last_seen_at. Two do
-- not — speedtest_results is indexed (agent_id, ts) and transaction_results
-- (test_id, agent_id, time), neither of which serves a range on the timestamp
-- alone. Added here.
--
-- RE-RUNNABLE: each CREATE INDEX is guarded through information_schema (the
-- idiom from migration 077), so applying the chain twice is a no-op the second
-- time rather than a duplicate-key error that stops the server's boot.
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'speedtest_results'
                      AND index_name = 'idx_speedtest_ts'),
  'DO 0', 'CREATE INDEX idx_speedtest_ts ON speedtest_results (ts)');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'transaction_results'
                      AND index_name = 'idx_txr_time'),
  'DO 0', 'CREATE INDEX idx_txr_time ON transaction_results (`time`)');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
