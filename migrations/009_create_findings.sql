-- 009 — analysis findings. Each row is a detected condition; explanation and
-- evidence are mandatory (enforced in the FindingStore before insert).
CREATE TABLE IF NOT EXISTS findings (
  id CHAR(36) NOT NULL,
  host_id VARCHAR(255) NOT NULL,
  metric VARCHAR(255) NOT NULL,
  severity ENUM('INFO', 'WARN', 'CRIT') NOT NULL,
  kind ENUM('ANOMALY', 'THRESHOLD', 'FLATLINE', 'CORRELATED') NOT NULL,
  observed DOUBLE NULL DEFAULT NULL,
  baseline DOUBLE NULL DEFAULT NULL,
  deviation DOUBLE NULL DEFAULT NULL,
  window_from DATETIME NULL DEFAULT NULL,
  window_to DATETIME NULL DEFAULT NULL,
  explanation TEXT NOT NULL,
  evidence JSON NOT NULL,
  correlated_with JSON NULL DEFAULT NULL,
  acked TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_findings_host_created (host_id, created_at),
  KEY idx_findings_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
