-- 055 — remediation playbooks + their per-incident run history.
--
-- A "remediation playbook" is a pre-defined response tied to an anomaly-type
-- (the incident's primary finding `metric`, e.g. 'cpu', 'io.await'): either an
-- automatic action (`auto_trigger = 1`, `action_type` names the automation) or a
-- manual runbook (`manual_action_text`). The recommendation endpoint
-- (GET /api/incidents/:id/recommendation) looks a playbook up by the incident's
-- primary anomaly-type via `trigger_condition` — an EXACT match, no DSL (local +
-- explainable, consistent with the rest of the analysis stack).
--
-- `incident_playbook_runs` is the incident<->playbook link the recommendation
-- reads: it records that a playbook was executed against a specific incident and
-- how it turned out, so the recommendation can surface the outcome ("already
-- run") instead of re-suggesting the same playbook. Automatic execution /
-- recording of runs is out of scope here — the run table is populated by a later
-- phase; this migration only creates the schema the read path depends on.

CREATE TABLE IF NOT EXISTS remediation_playbooks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(200) NOT NULL,
  trigger_condition VARCHAR(120) NOT NULL,      -- matched (exact) against the incident's primary anomaly-type (finding metric)
  action_type VARCHAR(60) NOT NULL,             -- remediation category, e.g. 'restart_service', 'run_probe', 'notify', 'manual'
  auto_trigger TINYINT(1) NOT NULL DEFAULT 0,   -- 1 = automatic action; 0 = manual runbook (see manual_action_text)
  manual_action_text TEXT NULL DEFAULT NULL,    -- operator instructions for a manual playbook
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_remediation_playbooks_trigger (trigger_condition, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS incident_playbook_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  incident_case_id BIGINT UNSIGNED NOT NULL,
  playbook_id INT UNSIGNED NOT NULL,
  status ENUM('pending', 'succeeded', 'failed') NOT NULL DEFAULT 'pending',
  result_text TEXT NULL DEFAULT NULL,
  ran_by VARCHAR(120) NULL DEFAULT NULL,        -- user email or 'system'
  ran_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_incident_playbook_runs_incident (incident_case_id, ran_at),
  KEY idx_incident_playbook_runs_playbook (playbook_id),
  CONSTRAINT fk_incident_playbook_runs_incident FOREIGN KEY (incident_case_id)
    REFERENCES incident_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_incident_playbook_runs_playbook FOREIGN KEY (playbook_id)
    REFERENCES remediation_playbooks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
