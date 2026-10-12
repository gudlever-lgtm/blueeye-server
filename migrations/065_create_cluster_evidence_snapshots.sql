-- 065 — automated evidence snapshots on cluster open (Fase 6).
--
-- When a cross-agent cluster opens, BlueEye captures a READ-ONLY diagnostic
-- snapshot from each affected target via the existing (authenticated, audited)
-- agent-command path — interface counters, ARP/MAC extract, allowlisted SNMP
-- reads, agent-local state. The result is EVIDENCE, not time series: one
-- compressed blob per (cluster, target), referenced from the incident timeline —
-- NOT rows in metric tables, and never in TimescaleDB.
--
-- Partial results are valid: `items` records each requested command's outcome
-- (ok / timeout / refused / agent-offline) so "what we could and couldn't see" is
-- explicit. Retention follows the existing rule (the age-out job skips snapshots
-- whose cluster still has an unacknowledged CRIT finding; otherwise default 90d).
CREATE TABLE IF NOT EXISTS cluster_evidence_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cluster_id BIGINT UNSIGNED NOT NULL,
  target VARCHAR(64) NOT NULL,                     -- affected agent id (findings.host_id)
  command_set_version VARCHAR(32) NOT NULL,        -- the read-only allowlist version used
  status ENUM('pending', 'complete', 'partial', 'failed', 'agent-offline') NOT NULL DEFAULT 'pending',
  items JSON NOT NULL,                             -- [{ name, status }] per read-only command
  payload_gzip MEDIUMBLOB NULL DEFAULT NULL,       -- gzip of the concatenated raw text evidence
  payload_bytes INT UNSIGNED NOT NULL DEFAULT 0,   -- uncompressed size (for the UI, no decompress)
  captured_at DATETIME NOT NULL,
  `trigger` VARCHAR(16) NOT NULL DEFAULT 'auto',   -- 'auto' (cluster-open) or 'manual' (re-snapshot); reserved word → backticked
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_evidence_cluster (cluster_id, captured_at),
  KEY idx_evidence_captured (captured_at),
  CONSTRAINT fk_evidence_cluster FOREIGN KEY (cluster_id)
    REFERENCES incident_clusters (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
