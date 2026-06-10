-- 032 — unified, server-wide audit trail surfaced under Reporting → Audit.
-- Captures WHO (actor), WHEN (ts) and WHAT (action + target) for two kinds of
-- activity:
--   * user actions on the server — every successful state-changing request
--     (login + POST/PUT/PATCH/DELETE), recorded by the audit middleware;
--   * agent activity — what each agent actually performed (traffic measurements,
--     probes), recorded on ingest.
--
-- Repeated/recurring activity (continuous traffic reporting, scheduled probes)
-- is NOT one row per occurrence: the FIRST run is audited and every repeat is
-- folded onto that same row (occurrences++, last_seen_at bumped) via a nullable
-- UNIQUE dedup_key + INSERT ... ON DUPLICATE KEY UPDATE. Discrete user actions
-- leave dedup_key NULL (many NULLs are allowed in a MySQL unique index), so each
-- one is its own row. Holds NO secrets — bodies are redacted before they land in
-- `detail`.
CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Actor: 'user' (JWT identity), 'agent' (opaque token) or 'system'.
  actor_type VARCHAR(16) NOT NULL,
  actor_id INT UNSIGNED NULL DEFAULT NULL,
  actor_label VARCHAR(255) NULL DEFAULT NULL,  -- snapshot (e.g. user email)
  actor_role VARCHAR(32) NULL DEFAULT NULL,
  -- What was done: a dotted action key (e.g. 'user.update', 'agent.run-test',
  -- 'settings.update', 'agent.traffic-report') + the affected target.
  action VARCHAR(96) NOT NULL,
  target_type VARCHAR(64) NULL DEFAULT NULL,
  target_id VARCHAR(64) NULL DEFAULT NULL,
  target_label VARCHAR(255) NULL DEFAULT NULL,
  -- HTTP context (for user actions) — handy for forensics, never required.
  method VARCHAR(8) NULL DEFAULT NULL,
  path VARCHAR(255) NULL DEFAULT NULL,
  status INT NULL DEFAULT NULL,
  ip VARCHAR(64) NULL DEFAULT NULL,
  detail JSON NULL DEFAULT NULL,               -- redacted request body / extras
  -- Recurrence: set on recurring activity so the UI can show "Repeats ...".
  repeat_interval_ms INT UNSIGNED NULL DEFAULT NULL,
  occurrences INT UNSIGNED NOT NULL DEFAULT 1,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL for discrete rows; set (and UNIQUE) for repeat-suppressed activity.
  dedup_key VARCHAR(255) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_dedup (dedup_key),
  KEY idx_audit_ts (ts),
  KEY idx_audit_actor (actor_type, actor_id),
  KEY idx_audit_action (action),
  KEY idx_audit_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
