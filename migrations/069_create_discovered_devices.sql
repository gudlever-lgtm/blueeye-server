-- 069 — discovered device candidates (scheduled active discovery).
--
-- Scheduled active discovery finds devices that passive collection (LLDP, sFlow,
-- agents) misses, by probing admin-configured CIDR scope. Results land here as
-- CANDIDATES — they are NEVER auto-enrolled. A candidate becomes a monitored
-- device only when an admin explicitly promotes it (which creates an `agents`
-- row and sets promoted_agent_id + status='promoted').
--
-- This table is intentionally STANDALONE (not an `agents` row) — a candidate is
-- by definition not yet a monitored device. `promoted_agent_id` is nullable and
-- only set on promotion (FK ON DELETE SET NULL so deleting the promoted agent
-- doesn't delete the discovery record).
CREATE TABLE IF NOT EXISTS discovered_devices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ip VARCHAR(45) NOT NULL,
  hostname VARCHAR(255) NULL DEFAULT NULL,           -- reverse-DNS name, if any
  open_ports VARCHAR(255) NULL DEFAULT NULL,         -- comma-separated open TCP ports
  icmp TINYINT(1) NOT NULL DEFAULT 0,                -- responded to ICMP echo
  status ENUM('discovered','promoted','ignored') NOT NULL DEFAULT 'discovered',
  promoted_agent_id INT UNSIGNED NULL DEFAULT NULL,
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_discovered_ip (ip),
  KEY idx_discovered_status (status, last_seen),
  CONSTRAINT fk_discovered_promoted_agent FOREIGN KEY (promoted_agent_id)
    REFERENCES agents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
