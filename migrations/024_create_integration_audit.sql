-- 024 — audit trail for outbound integration calls. One row per fire (an event
-- trigger or a manual test), capturing the outcome (ok/fail), the target's HTTP
-- status code, the number of attempts (retry/backoff), and WHO triggered a manual
-- test (system-triggered events have no actor). The integration name + type are
-- SNAPSHOTTED so the trail survives the integration being deleted (the FK then
-- nulls but the row remains). Holds NO secrets — credentials/tokens are never
-- written here.
CREATE TABLE IF NOT EXISTS integration_audit (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  integration_id INT UNSIGNED NULL DEFAULT NULL,
  integration_name VARCHAR(255) NULL DEFAULT NULL,
  integration_type VARCHAR(32) NULL DEFAULT NULL,
  event VARCHAR(64) NOT NULL,                  -- 'incident' | 'anomaly' | 'agent.enroll' | 'agent.delete' | 'test'
  correlation_id VARCHAR(255) NULL DEFAULT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  status_code INT NULL DEFAULT NULL,           -- HTTP status from the target (NULL on a network failure)
  attempts INT UNSIGNED NOT NULL DEFAULT 1,
  detail VARCHAR(512) NULL DEFAULT NULL,
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,
  actor_email VARCHAR(255) NULL DEFAULT NULL,
  actor_role VARCHAR(32) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_integration_audit_integration (integration_id, created_at),
  KEY idx_integration_audit_event (event, created_at),
  CONSTRAINT fk_integration_audit_integration FOREIGN KEY (integration_id)
    REFERENCES integrations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
