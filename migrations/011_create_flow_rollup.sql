-- 011 — down-sampled flow records. Raw flow_records older than the raw-retention
-- window are aggregated into time buckets per (agent, direction, peer country,
-- peer ASN). Only external (geolocated) flows are rolled up. The unique key lets
-- a re-run merge instead of duplicating (idempotent rollup).
CREATE TABLE IF NOT EXISTS flow_rollup (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bucket DATETIME NOT NULL,
  agent_id INT UNSIGNED NOT NULL,
  direction ENUM('in', 'out') NOT NULL DEFAULT 'out',
  country CHAR(2) NOT NULL DEFAULT '',
  asn INT UNSIGNED NOT NULL DEFAULT 0,
  asn_name VARCHAR(255) NULL DEFAULT NULL,
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  packets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  flow_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes_min BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes_max BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes_median DOUBLE NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_flow_rollup_bucket (agent_id, bucket, direction, country, asn),
  KEY idx_flow_rollup_bucket (bucket),
  KEY idx_flow_rollup_country (country, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
