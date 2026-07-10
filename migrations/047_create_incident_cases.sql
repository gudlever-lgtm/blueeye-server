-- 047 — incidents as a first-class entity, wrapping analysis findings.
-- One incident_case groups one or more findings (the system's "anomalies") that
-- fire on the same device (host_id) within a correlation window. `severity` is
-- inherited from the highest severity among the linked findings; `title` is
-- auto-generated from the primary finding. Findings link back through
-- findings.incident_case_id (added in migration 048).
--
-- Wrap, not replace: the pre-existing `incidents` table (migration 025, active-
-- probe outages) is a different concept and is left completely untouched. This
-- table's FK is named `primary_finding_id` because the anomaly rows it points at
-- live in `findings` — there is no `anomalies` table in this codebase.
CREATE TABLE IF NOT EXISTS incident_cases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  host_id VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status ENUM('open', 'investigating', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  severity ENUM('INFO', 'WARN', 'CRIT') NOT NULL DEFAULT 'INFO',
  primary_finding_id CHAR(36) NULL DEFAULT NULL,
  first_event_at DATETIME NOT NULL,
  last_event_at DATETIME NOT NULL,
  resolved_at DATETIME NULL DEFAULT NULL,
  created_by ENUM('system', 'manual') NOT NULL DEFAULT 'system',
  closed_by INT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_incident_cases_host_status (host_id, status),
  KEY idx_incident_cases_status (status),
  KEY idx_incident_cases_last_event (last_event_at),
  CONSTRAINT fk_incident_cases_primary_finding FOREIGN KEY (primary_finding_id)
    REFERENCES findings (id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_cases_closed_by FOREIGN KEY (closed_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
