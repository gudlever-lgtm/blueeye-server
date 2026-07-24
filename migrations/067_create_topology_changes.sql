-- 067 — topology change records + LLDP link-state.
--
-- Detects and records topology changes between LLDP poll cycles (each agent
-- capabilities report is a "poll"). The change types:
--   neighbour_added / neighbour_removed — an edge appears / disappears
--   link_state_changed                  — an edge's link state flips
--   port_moved                          — the same remote chassis id is seen on a
--                                          different local port
--   flapping                            — a change that reverts within a window
--                                          (default 300s) collapses to one record
--
-- Change records reuse the target-timeline event shape on read
-- ({ timestamp, source:'topology', type, severity, summary, ref_id }) — no second
-- changes format — and each change is also written to the hash-chained audit_log
-- (mig 033/041) as immutable evidence (audit_log_id references it).
--
-- `lldp_neighbors` gains a nullable `link_state` so a previous snapshot can carry
-- state to diff against (additive; NULL when the agent doesn't report it).
ALTER TABLE lldp_neighbors
  ADD COLUMN link_state VARCHAR(16) NULL DEFAULT NULL AFTER remote_port;

CREATE TABLE IF NOT EXISTS topology_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,                   -- the reporting agent (host)
  change_type ENUM('neighbour_added','neighbour_removed','link_state_changed','port_moved','flapping') NOT NULL,
  local_port VARCHAR(190) NULL DEFAULT NULL,
  remote_chassis_id VARCHAR(190) NULL DEFAULT NULL,
  remote_port VARCHAR(190) NULL DEFAULT NULL,
  from_local_port VARCHAR(190) NULL DEFAULT NULL,   -- port_moved: the previous local port
  link_state_from VARCHAR(16) NULL DEFAULT NULL,
  link_state_to VARCHAR(16) NULL DEFAULT NULL,
  severity ENUM('INFO','WARN','CRIT') NOT NULL DEFAULT 'INFO',
  summary VARCHAR(512) NOT NULL,
  detected_at DATETIME(3) NOT NULL,
  audit_log_id BIGINT UNSIGNED NULL DEFAULT NULL,   -- the hash-chained evidence row (mig 033/041)
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_topo_changes_agent (agent_id, detected_at),
  KEY idx_topo_changes_chassis (remote_chassis_id),
  KEY idx_topo_changes_detected (detected_at),
  CONSTRAINT fk_topo_changes_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
