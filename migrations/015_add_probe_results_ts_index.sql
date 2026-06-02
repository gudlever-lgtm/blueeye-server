-- 015 — index probe_results by ts alone. The fleet-health overview scans recent
-- probes across ALL agents (WHERE ts >= ? ORDER BY ts DESC), which the existing
-- (agent_id, ts) composite key can't serve efficiently. A plain ts index bounds
-- that range scan.
CREATE INDEX idx_probe_ts ON probe_results (ts);
