-- 059 — durable alert-dispatch log.
--
-- Records each alert actually dispatched to a channel, for TWO purposes:
--   * finding-level rows (subject_type='finding', subject_id = findings.id) let the
--     cross-agent cluster alert REFERENCE the member findings already alerted
--     individually — so it can say "N members already notified" instead of resending;
--   * cluster-level rows (subject_type='cluster', subject_id = incident_clusters.id)
--     make "fire once per cluster" DURABLE — a cluster alerts at most once even across
--     restarts (the dispatcher's throttle is in-memory only).
--
-- Metadata only (ids/metric/severity/channel names) — never payload. Best-effort:
-- the dispatcher writes it after a send and a failure here never affects alerting.
CREATE TABLE IF NOT EXISTS alert_dispatch_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subject_type ENUM('finding', 'cluster') NOT NULL,
  subject_id VARCHAR(64) NOT NULL,               -- findings.id (UUID) or incident_clusters.id
  host_id VARCHAR(64) NULL DEFAULT NULL,
  metric VARCHAR(120) NULL DEFAULT NULL,
  severity VARCHAR(16) NULL DEFAULT NULL,
  channels VARCHAR(255) NULL DEFAULT NULL,        -- comma-separated channel names that sent OK
  sent_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_alert_dispatch_subject (subject_type, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
