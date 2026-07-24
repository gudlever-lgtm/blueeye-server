-- 066 — service dependency graph edges.
--
-- Directed, aggregated "who-talks-to-whom-on-which-port" edges between two
-- MONITORED hosts, derived from observed TCP flows (never payload). One row per
-- (src_host_id, dst_host_id, dst_port) over a rolling window (default 24h); a
-- leader-only scheduled job (src/topology/serviceDependencyJob.js) recomputes it
-- off the ingest hot path, upserting the current aggregate and ageing out edges
-- not seen within the window. This is the 'service_dep' edge type of the unified
-- topology graph — the LLDP 'l2_link' edges live in `lldp_neighbors` (mig 063);
-- the graph model (src/topology/graph.js) merges both into one typed edge list.
--
-- Both endpoints are always a monitored host = an `agents` row (a plain agent OR
-- an SNMP-monitored device, both represented by an agent id). Edges where either
-- endpoint's IP does not resolve to a known host are dropped by the job and never
-- stored. bytes/packets/conn_count are the summed volume over the window;
-- conn_count is the observed flow count (the closest proxy to connection count
-- from sampled/exported flow data). first_seen/last_seen bound the window the
-- edge was observed in.
--
-- Stored in MySQL (not TimescaleDB): like `lldp_neighbors` this is a mutable,
-- keyed, current-state graph-edge table maintained by upsert + age-out, not
-- append-only telemetry — its natural UNIQUE key excludes time, which a
-- hypertable cannot enforce.
CREATE TABLE IF NOT EXISTS service_dependencies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  src_host_id INT UNSIGNED NOT NULL,                -- client host (agents.id)
  dst_host_id INT UNSIGNED NOT NULL,                -- server host (agents.id)
  dst_port INT UNSIGNED NOT NULL,                   -- service port on dst_host
  proto VARCHAR(16) NOT NULL DEFAULT 'tcp',         -- v1 is TCP only
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  packets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  conn_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_dep_edge (src_host_id, dst_host_id, dst_port),
  KEY idx_service_dep_src (src_host_id, bytes),
  KEY idx_service_dep_dst (dst_host_id, bytes),
  KEY idx_service_dep_last_seen (last_seen),
  CONSTRAINT fk_service_dep_src FOREIGN KEY (src_host_id)
    REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_service_dep_dst FOREIGN KEY (dst_host_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
