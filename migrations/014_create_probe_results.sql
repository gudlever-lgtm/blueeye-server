-- 014 — active-probe results. The agent runs ping / TCP-connect / DNS /
-- traceroute probes (on operator command) and reports them here, giving
-- reachability + latency/loss/jitter over time for troubleshooting. Metadata
-- only: targets and timings, never payload.
CREATE TABLE IF NOT EXISTS probe_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  ts DATETIME NOT NULL,
  type VARCHAR(16) NOT NULL,          -- ping | tcp | dns | traceroute
  target VARCHAR(255) NOT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  rtt_ms DOUBLE NULL DEFAULT NULL,    -- average round-trip time
  min_ms DOUBLE NULL DEFAULT NULL,
  max_ms DOUBLE NULL DEFAULT NULL,
  jitter_ms DOUBLE NULL DEFAULT NULL,
  loss_pct DOUBLE NULL DEFAULT NULL,
  hops JSON NULL DEFAULT NULL,        -- traceroute path [{hop,ip,rttMs}]
  detail VARCHAR(255) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_probe_agent_ts (agent_id, ts),
  KEY idx_probe_agent_type_ts (agent_id, type, ts),
  CONSTRAINT fk_probe_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
