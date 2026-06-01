-- 012 — down-sampled metric time-series. Raw metric samples (extracted from
-- result payloads) older than the raw-retention window are aggregated into time
-- buckets per (agent, metric), keeping min/max/median and a sample count. The
-- unique key makes re-runs idempotent (merge instead of duplicate).
CREATE TABLE IF NOT EXISTS metric_rollup (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bucket DATETIME NOT NULL,
  agent_id INT UNSIGNED NOT NULL,
  metric VARCHAR(64) NOT NULL,
  samples INT UNSIGNED NOT NULL DEFAULT 0,
  val_min DOUBLE NOT NULL DEFAULT 0,
  val_max DOUBLE NOT NULL DEFAULT 0,
  val_median DOUBLE NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_metric_rollup_bucket (agent_id, metric, bucket),
  KEY idx_metric_rollup_bucket (bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
