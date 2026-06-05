-- 018 — active throughput ("speed test") results. The agent downloads then
-- uploads a sized blob to/from this server and reports the achieved rate in
-- Mbps. Self-contained (no external speed-test service). Metadata only: byte
-- counts and timings, never payload.
CREATE TABLE IF NOT EXISTS speedtest_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  ts DATETIME NOT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  down_mbps DOUBLE NULL DEFAULT NULL,
  up_mbps DOUBLE NULL DEFAULT NULL,
  down_bytes BIGINT UNSIGNED NULL DEFAULT NULL,
  up_bytes BIGINT UNSIGNED NULL DEFAULT NULL,
  down_ms DOUBLE NULL DEFAULT NULL,
  up_ms DOUBLE NULL DEFAULT NULL,
  target VARCHAR(255) NULL DEFAULT NULL,
  detail VARCHAR(255) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_speedtest_agent_ts (agent_id, ts),
  CONSTRAINT fk_speedtest_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
