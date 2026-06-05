-- 017 — server-defined "test packages": a named set of probe/traffic tests the
-- server pushes to selected agents (all / specific / by location) to run, on a
-- schedule or on demand. Agents execute via the existing run-probe / run-test
-- commands and report results through the normal endpoints. Metadata only:
-- targets and timings, never payload.
CREATE TABLE IF NOT EXISTS test_packages (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  schedule_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,   -- 0 = manual only (no schedule)
  targets JSON NOT NULL,                            -- {mode:'all'|'agents'|'location', agentIds:[], locationIds:[]}
  items JSON NOT NULL,                              -- [{type:'probe', probe:{...}} | {type:'run-test', intervalMs?}]
  created_by VARCHAR(255) NULL DEFAULT NULL,
  last_run_at DATETIME NULL DEFAULT NULL,
  last_run_summary JSON NULL DEFAULT NULL,          -- {at, targeted, reached, delivered, items}
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_test_packages_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
