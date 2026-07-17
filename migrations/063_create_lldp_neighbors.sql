-- 063 — LLDP neighbor relations: a minimal, queryable L2 topology (Fase 4).
--
-- Persists the LLDP neighbor adjacencies an agent observes on its device, so the
-- cross-agent clustering engine (migration 057) can use L2 adjacency as a topology
-- signal when no shared-site (manual) topology groups the findings. This is NOT
-- auto-discovery: rows arrive on the EXISTING agent report path (a `capabilities.
-- lldp` list) — no new SNMP polling here — and stale rows age out.
--
-- `local_chassis_id` is the reporting device's OWN chassis id (from its LLDP local
-- system data). It lets us resolve a neighbor's `remote_chassis_id` back to the
-- agent monitoring that device, turning per-port neighbor rows into an agent↔agent
-- adjacency graph (e.g. "sw-03 adjacent to sw-04"). It is nullable: partial LLDP
-- coverage yields a partial graph (missing edges are treated as UNKNOWN, never as
-- "not adjacent").
--
-- The UNIQUE key is the upsert identity: one row per (agent, local_port, remote
-- chassis, remote_port). Re-observing a neighbor bumps `last_seen`; rows not seen
-- within the configurable age-out window (default 24h) are deleted.
CREATE TABLE IF NOT EXISTS lldp_neighbors (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  local_agent_id INT UNSIGNED NOT NULL,             -- the reporting agent (findings.host_id)
  local_chassis_id VARCHAR(190) NULL DEFAULT NULL,  -- the reporting device's own chassis id
  local_port VARCHAR(190) NULL DEFAULT NULL,
  remote_chassis_id VARCHAR(190) NOT NULL,          -- the neighbor device's chassis id
  remote_port VARCHAR(190) NULL DEFAULT NULL,
  last_seen DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lldp_edge (local_agent_id, local_port, remote_chassis_id, remote_port),
  KEY idx_lldp_remote (remote_chassis_id),
  KEY idx_lldp_local_chassis (local_chassis_id),
  KEY idx_lldp_last_seen (last_seen),
  CONSTRAINT fk_lldp_local_agent FOREIGN KEY (local_agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
