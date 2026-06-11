-- 037 — cluster registry for high-availability deployments (feature
-- `ha_deployment`, Enterprise+). When blueeye-server runs as multiple replicas
-- behind a load balancer, each node upserts a heartbeat row here so the
-- status/admin API (`GET /api/ha/*`) and the dashboard can show the live cluster
-- topology and which node currently holds the leader lock.
--
-- Leader election itself uses MySQL's session-scoped advisory lock
-- (GET_LOCK/RELEASE_LOCK) and needs NO table — this registry is purely for
-- observability. Holds operational metadata only, never secrets.
CREATE TABLE IF NOT EXISTS ha_nodes (
  -- Stable per-replica identity (HA_NODE_ID, or hostname:pid when unset).
  node_id VARCHAR(191) NOT NULL,
  hostname VARCHAR(255) NULL DEFAULT NULL,
  pid INT UNSIGNED NULL DEFAULT NULL,
  version VARCHAR(32) NULL DEFAULT NULL,
  -- 1 while this node holds the leader advisory lock (runs the singleton jobs).
  is_leader TINYINT(1) NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (node_id),
  KEY idx_ha_nodes_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
