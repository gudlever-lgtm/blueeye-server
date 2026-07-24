-- 070 — host connection-table edges (agent-reported service dependencies).
--
-- A second SOURCE for the service dependency graph (mig 066), for hosts that run
-- no flow exporter. The agent reads its OWN established TCP connection table
-- (`ss`/`netstat`/Get-NetTCPConnection — metadata only, never payload) and folds
-- it into directed (src_ip → dst_ip : dst_port) edges from its own perspective,
-- reported alongside its capabilities. One row per (agent_id, src_ip, dst_ip,
-- dst_port); the reporting agent OWNS its rows (replaced wholesale on each
-- report), so a host with the `proc`/`snmp` source still contributes edges.
--
-- These carry a connection COUNT but no byte volume (a connection table has no
-- counters), so the service-dependency job feeds them into the SAME aggregator
-- as the flow rows (bytes/packets = 0, conn_count = the observed count) and the
-- IP→host resolution + unknown-endpoint drop are identical. Stored in MySQL for
-- the same reason as service_dependencies: a mutable, keyed, current-state table.
CREATE TABLE IF NOT EXISTS host_connections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,                   -- the agent that observed it
  src_ip VARCHAR(64) NOT NULL,                      -- client endpoint (IP)
  dst_ip VARCHAR(64) NOT NULL,                      -- server endpoint (IP)
  dst_port INT UNSIGNED NOT NULL,                   -- service port on dst
  conn_count INT UNSIGNED NOT NULL DEFAULT 0,       -- established connections seen
  last_seen DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_host_conn_edge (agent_id, src_ip, dst_ip, dst_port),
  KEY idx_host_conn_last_seen (last_seen),
  CONSTRAINT fk_host_conn_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
