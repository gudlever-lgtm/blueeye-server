-- 068 — per-flow-pair traffic-volume baselines.
--
-- Extends per-metric anomaly detection to per-(src_host, dst_host, dst_port).
-- Two tables:
--
-- 1. flow_pair_hourly — an APPEND-ONLY hourly volume rollup per tuple. The
--    service_dependencies table (mig 066) is a current-state snapshot with no
--    history, and raw flow_records is only kept ~7 days, so neither can back a
--    14-day baseline. A leader-only hourly job appends one row per (bucket, tuple)
--    from the same flow_records TCP + host-resolution path the service-dep job
--    uses. Retained >= the baseline window (default 14d); older rows purged.
--    History builds FORWARD from deploy (raw flows can't be backfilled).
--
-- 2. flow_pair_baselines — robust median + MAD baseline per tuple, bucketed by
--    day-of-week + hour-of-day (UTC), recomputed from flow_pair_hourly over the
--    window, reusing src/analysis/baselines.js (no new statistics). A pair needs
--    >= a minimum observation count (default 100 hourly buckets) before it is
--    eligible for scoring. Deviations are emitted to the correlator as ordinary
--    findings (kind ANOMALY) — deviation only, no threat classification.
CREATE TABLE IF NOT EXISTS flow_pair_hourly (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bucket DATETIME NOT NULL,                          -- hour start (UTC, epoch-grid)
  src_host_id INT UNSIGNED NOT NULL,
  dst_host_id INT UNSIGNED NOT NULL,
  dst_port INT UNSIGNED NOT NULL,
  proto VARCHAR(16) NOT NULL DEFAULT 'tcp',
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  packets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  conn_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_flow_pair_hourly (bucket, src_host_id, dst_host_id, dst_port),
  KEY idx_flow_pair_hourly_tuple (src_host_id, dst_host_id, dst_port, bucket),
  KEY idx_flow_pair_hourly_bucket (bucket),
  CONSTRAINT fk_flow_pair_hourly_src FOREIGN KEY (src_host_id) REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_flow_pair_hourly_dst FOREIGN KEY (dst_host_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_pair_baselines (
  src_host_id INT UNSIGNED NOT NULL,
  dst_host_id INT UNSIGNED NOT NULL,
  dst_port INT UNSIGNED NOT NULL,
  dow TINYINT UNSIGNED NOT NULL,                     -- day of week, UTC 0=Sun..6=Sat
  hour TINYINT UNSIGNED NOT NULL,                    -- hour of day, UTC 0..23
  median_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  mad_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  sample_count INT UNSIGNED NOT NULL DEFAULT 0,      -- buckets in THIS (dow,hour) group
  observation_count INT UNSIGNED NOT NULL DEFAULT 0, -- total buckets for the pair (eligibility gate)
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (src_host_id, dst_host_id, dst_port, dow, hour),
  KEY idx_flow_pair_baseline_src (src_host_id),
  CONSTRAINT fk_flow_pair_baseline_src FOREIGN KEY (src_host_id) REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_flow_pair_baseline_dst FOREIGN KEY (dst_host_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
