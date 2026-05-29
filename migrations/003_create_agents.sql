-- 003 — create the agents table.
CREATE TABLE IF NOT EXISTS agents (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Agent-reported fields (written by the agent itself at enrollment/heartbeat).
  hostname VARCHAR(255) NOT NULL,
  platform VARCHAR(64) NOT NULL,
  arch VARCHAR(32) NOT NULL,
  last_seen DATETIME NULL DEFAULT NULL,
  status ENUM('online', 'offline') NOT NULL DEFAULT 'offline',
  -- Server-managed fields (set by operators/admins through the API).
  location_id INT UNSIGNED NULL DEFAULT NULL,
  display_name VARCHAR(255) NULL DEFAULT NULL,
  notes TEXT NULL DEFAULT NULL,
  meta JSON NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_agents_location_id (location_id),
  CONSTRAINT fk_agents_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
