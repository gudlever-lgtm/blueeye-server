-- 024 — incidents derived from active-probe results. One row per detected
-- outage/degradation for a given (agent, metric, target). started_at is the
-- timestamp of the FIRST failing result in the sequence that breached the
-- threshold (not the result that crossed the debounce count); resolved_at is set
-- once a result comes back under threshold (NULL = still active). At most one
-- ACTIVE incident may exist per (agent_id, metric, affected_target) — enforced in
-- the derivation service (a partial unique index isn't expressible in MySQL).
CREATE TABLE IF NOT EXISTS incidents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  agent_id INT UNSIGNED NOT NULL,
  metric ENUM('reachability', 'latency', 'packet_loss') NOT NULL,
  severity ENUM('warning', 'critical') NOT NULL,
  started_at DATETIME NOT NULL,
  resolved_at DATETIME NULL DEFAULT NULL,
  duration_seconds INT UNSIGNED NULL DEFAULT NULL,
  affected_target VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_incidents_location_started (location_id, started_at),
  KEY idx_incidents_resolved (resolved_at),
  KEY idx_incidents_active (agent_id, metric, affected_target, resolved_at),
  CONSTRAINT fk_incidents_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_incidents_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
