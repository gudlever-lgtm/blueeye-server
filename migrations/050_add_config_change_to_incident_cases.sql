-- 050 — link an incident to the device-config change (config_snapshots row) that
-- is suspected to have triggered it (Fase 3 pt 4). Nullable, additive: set by the
-- automatic correlation when a new anomaly on a device arrives within a
-- configurable window (default 30m) after a config change. ON DELETE SET NULL so
-- pruning snapshots never deletes incidents.
ALTER TABLE incident_cases
  ADD COLUMN config_change_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER primary_finding_id,
  ADD KEY idx_incident_cases_config_change (config_change_id),
  ADD CONSTRAINT fk_incident_cases_config_change FOREIGN KEY (config_change_id)
    REFERENCES config_snapshots (id) ON DELETE SET NULL;
