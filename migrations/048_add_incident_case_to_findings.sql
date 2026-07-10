-- 048 — link findings (the system's "anomalies") to the incident_cases entity
-- introduced in migration 047. Nullable FK, additive only: existing columns and
-- rows are unchanged, and a finding with no incident (yet) simply keeps NULL.
-- ON DELETE SET NULL so removing an incident case never deletes its findings.
ALTER TABLE findings
  ADD COLUMN incident_case_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER correlated_with,
  ADD KEY idx_findings_incident_case (incident_case_id),
  ADD CONSTRAINT fk_findings_incident_case FOREIGN KEY (incident_case_id)
    REFERENCES incident_cases (id) ON DELETE SET NULL;
