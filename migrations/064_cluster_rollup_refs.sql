-- 064 — cross-agent cluster: alert-rollup state + external references (Fase 5).
--
-- Turns per-finding notification into per-INCIDENT notification. During a
-- clustered incident, alerts, ITSM tickets and NIS2 drafts roll up to the cluster
-- instead of firing N times. These columns hold the rollup state + the external
-- refs the rollup needs:
--
--   alert_last_at / alert_last_severity / alert_member_count
--     — the last cluster-level alert's time, severity and member count, so the
--       digest window ("update at most every N min"), the escalation bypass
--       (severity climbed) and "new members since last update" are computable.
--   itsm_ticket_ref / itsm_integration_id
--     — the ONE external ticket a clustered incident maps to (created once,
--       appended to with worknotes). Idempotency key is be-cluster-<id>.
--   nis2_draft_id
--     — the ONE cluster-level NIS2 draft (blueeye_nis2_incidents.id), so
--       per-finding drafts for members are suppressed in favour of it.
ALTER TABLE incident_clusters
  ADD COLUMN alert_last_at DATETIME NULL DEFAULT NULL AFTER advisory,
  ADD COLUMN alert_last_severity VARCHAR(16) NULL DEFAULT NULL AFTER alert_last_at,
  ADD COLUMN alert_member_count INT UNSIGNED NULL DEFAULT NULL AFTER alert_last_severity,
  ADD COLUMN itsm_ticket_ref VARCHAR(190) NULL DEFAULT NULL AFTER alert_member_count,
  ADD COLUMN itsm_integration_id INT UNSIGNED NULL DEFAULT NULL AFTER itsm_ticket_ref,
  ADD COLUMN nis2_draft_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER itsm_integration_id;
