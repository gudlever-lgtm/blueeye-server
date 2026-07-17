-- 061 — runbooks: the static finding-type → recommended-action mapping.
--
-- The "Recommended actions" bridge (Fase 3). A runbook maps an anomaly
-- finding-type (e.g. 'cpu', 'probe.loss' — the finding `metric`) to a
-- human-readable, markdown remediation, optionally linked to a remediation
-- playbook (migration 055) so an operator can run it from the incident page.
--
-- Static mapping FIRST, AI second: this table is a zero-latency, zero-AI lookup
-- that covers most cases; the opt-in Mistral advisory (Fase 2) stays garnish.
--
-- `finding_type` is matched EXACTLY against a cluster's dominant finding metrics
-- (no DSL — consistent with remediation_playbooks.trigger_condition). It is NOT
-- unique: several runbooks may target the same finding-type (all are surfaced).
CREATE TABLE IF NOT EXISTS runbooks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  finding_type VARCHAR(120) NOT NULL,             -- matched (exact) against a finding metric
  title VARCHAR(200) NOT NULL,
  body_markdown MEDIUMTEXT NOT NULL,              -- rendered client-side; no HTML stored
  linked_playbook_id INT UNSIGNED NULL DEFAULT NULL,
  updated_by INT UNSIGNED NULL DEFAULT NULL,      -- users.id of the last editor
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_runbooks_finding_type (finding_type),
  CONSTRAINT fk_runbooks_playbook FOREIGN KEY (linked_playbook_id)
    REFERENCES remediation_playbooks (id) ON DELETE SET NULL,
  CONSTRAINT fk_runbooks_updated_by FOREIGN KEY (updated_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
