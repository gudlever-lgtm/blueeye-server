-- 077 — rename the incident_* entities to their real names.
--
-- BlueEyes produces EVENTS. An "incident" is what a connected ITSM opens from
-- one, and it lives there with its own number, SLA and owner. Migration 047
-- named our own grouped-anomaly entity `incident_cases`, which made the two
-- indistinguishable in every query and log line. This renames the storage layer
-- to match the vocabulary the API and dashboard already use (PR #228).
--
-- Two different things were both called "incident", and they split here:
--
--   * incident_cases (047) — grouped anomalies, the thing the Events tab shows.
--     Becomes event_cases, with event_notes / event_clusters / event_playbook_runs
--     hanging off it and findings.event_case_id pointing at it.
--   * incidents (025) — one row per (agent, metric, target) probe outage derived
--     from probe_results. Never an event case; it becomes probe_outages, and its
--     threshold table becomes probe_thresholds.
--
-- The NIS2 tables are deliberately NOT renamed: blueeye_nis2_incidents keeps
-- "incident" because that is the word the directive uses, and the reports built
-- from it are read by regulators against that wording. Same carve-out as the
-- ITSM connectors.
--
-- Data-preserving: RENAME TABLE and ALTER ... CHANGE keep every row. Foreign
-- keys and indexes are renamed explicitly — MySQL carries the OLD constraint
-- names through a table rename, so without this the schema would still be full
-- of fk_incident_* names pointing at event_* tables.
--
-- Two kinds of index are renamed here, and they need different handling:
--
--   * Indexes DECLARED in the original migration (idx_…, uq_…). Certain to
--     exist under that exact name — renamed directly.
--   * Indexes InnoDB AUTO-CREATED to back a FOREIGN KEY that had no suitable
--     index of its own (e.g. fk_incident_cases_primary_finding). InnoDB names
--     those after the CONSTRAINT, so dropping the FK leaves an index still
--     called fk_incident_*. Whether one exists depends on the server version
--     and on what other indexes covered the column, so those are renamed
--     CONDITIONALLY via information_schema. A hard RENAME INDEX would abort the
--     migration on any deployment that happens not to have it — and DDL
--     implicitly commits, so an aborted run leaves a half-renamed database.
--
-- Clean break: no compatibility views are left behind. Anything still querying
-- the old table names fails loudly on upgrade rather than silently reading a
-- stale shim.
--
-- NOT touched: the hash-chained `audit_log` rows whose category is `incident`.
-- Rewriting them would break the chain, so the readers match both categories
-- instead (src/routes/events.js, src/eventCases/askContext.js).

-- ---------------------------------------------------------------------------
-- 1) Tables
-- ---------------------------------------------------------------------------
RENAME TABLE
  incident_cases         TO event_cases,
  incident_notes         TO event_notes,
  incident_clusters      TO event_clusters,
  incident_playbook_runs TO event_playbook_runs,
  incidents              TO probe_outages,
  incident_thresholds    TO probe_thresholds;

-- ---------------------------------------------------------------------------
-- 2) event_cases — indexes + constraints inherited from 047 and 050
-- ---------------------------------------------------------------------------
ALTER TABLE event_cases
  DROP FOREIGN KEY fk_incident_cases_primary_finding;
ALTER TABLE event_cases
  DROP FOREIGN KEY fk_incident_cases_closed_by;
ALTER TABLE event_cases
  DROP FOREIGN KEY fk_incident_cases_config_change;

ALTER TABLE event_cases
  RENAME INDEX idx_incident_cases_host_status   TO idx_event_cases_host_status,
  RENAME INDEX idx_incident_cases_status        TO idx_event_cases_status,
  RENAME INDEX idx_incident_cases_last_event    TO idx_event_cases_last_event,
  RENAME INDEX idx_incident_cases_config_change TO idx_event_cases_config_change;

-- primary_finding_id and closed_by had no declared index in 047, so InnoDB very
-- likely auto-created one named after each constraint. Rename before re-adding
-- the FKs, so the new constraints adopt an index that is no longer called
-- fk_incident_*.
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'event_cases'
                      AND index_name = 'fk_incident_cases_primary_finding'),
  'ALTER TABLE event_cases RENAME INDEX fk_incident_cases_primary_finding TO idx_event_cases_primary_finding', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'event_cases'
                      AND index_name = 'fk_incident_cases_closed_by'),
  'ALTER TABLE event_cases RENAME INDEX fk_incident_cases_closed_by TO idx_event_cases_closed_by', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

ALTER TABLE event_cases
  ADD CONSTRAINT fk_event_cases_primary_finding FOREIGN KEY (primary_finding_id)
    REFERENCES findings (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_event_cases_closed_by FOREIGN KEY (closed_by)
    REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_event_cases_config_change FOREIGN KEY (config_change_id)
    REFERENCES config_snapshots (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 3) findings.incident_case_id — the link added in 048
-- ---------------------------------------------------------------------------
ALTER TABLE findings
  DROP FOREIGN KEY fk_findings_incident_case;
ALTER TABLE findings
  CHANGE incident_case_id event_case_id BIGINT UNSIGNED NULL DEFAULT NULL;
ALTER TABLE findings
  RENAME INDEX idx_findings_incident_case TO idx_findings_event_case;
ALTER TABLE findings
  ADD CONSTRAINT fk_findings_event_case FOREIGN KEY (event_case_id)
    REFERENCES event_cases (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 4) event_notes — from 072
-- ---------------------------------------------------------------------------
ALTER TABLE event_notes
  DROP FOREIGN KEY fk_incident_notes_case;
ALTER TABLE event_notes
  DROP FOREIGN KEY fk_incident_notes_author;
ALTER TABLE event_notes
  CHANGE incident_case_id event_case_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE event_notes
  RENAME INDEX idx_incident_notes_case      TO idx_event_notes_case,
  RENAME INDEX idx_incident_notes_ruled_out TO idx_event_notes_ruled_out;
-- author_user_id had no declared index in 072 (only the two case indexes), so
-- its FK-backing index is auto-named too.
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'event_notes'
                      AND index_name = 'fk_incident_notes_author'),
  'ALTER TABLE event_notes RENAME INDEX fk_incident_notes_author TO idx_event_notes_author', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

ALTER TABLE event_notes
  ADD CONSTRAINT fk_event_notes_case FOREIGN KEY (event_case_id)
    REFERENCES event_cases (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_event_notes_author FOREIGN KEY (author_user_id)
    REFERENCES users (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 5) event_playbook_runs — from 055
-- ---------------------------------------------------------------------------
ALTER TABLE event_playbook_runs
  DROP FOREIGN KEY fk_incident_playbook_runs_incident;
ALTER TABLE event_playbook_runs
  DROP FOREIGN KEY fk_incident_playbook_runs_playbook;
ALTER TABLE event_playbook_runs
  CHANGE incident_case_id event_case_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE event_playbook_runs
  RENAME INDEX idx_incident_playbook_runs_incident TO idx_event_playbook_runs_event,
  RENAME INDEX idx_incident_playbook_runs_playbook TO idx_event_playbook_runs_playbook;
ALTER TABLE event_playbook_runs
  ADD CONSTRAINT fk_event_playbook_runs_event FOREIGN KEY (event_case_id)
    REFERENCES event_cases (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_event_playbook_runs_playbook FOREIGN KEY (playbook_id)
    REFERENCES remediation_playbooks (id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 6) event_clusters — from 057 and 060
-- ---------------------------------------------------------------------------
ALTER TABLE event_clusters
  DROP FOREIGN KEY fk_incident_clusters_ack_by;
ALTER TABLE event_clusters
  DROP FOREIGN KEY fk_incident_clusters_resolved_by;
ALTER TABLE event_clusters
  RENAME INDEX idx_incident_clusters_status_detected TO idx_event_clusters_status_detected;
-- acknowledged_by / resolved_by were added with their FKs in 060 and no index
-- of their own, so both backing indexes are auto-named.
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'event_clusters'
                      AND index_name = 'fk_incident_clusters_ack_by'),
  'ALTER TABLE event_clusters RENAME INDEX fk_incident_clusters_ack_by TO idx_event_clusters_ack_by', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'event_clusters'
                      AND index_name = 'fk_incident_clusters_resolved_by'),
  'ALTER TABLE event_clusters RENAME INDEX fk_incident_clusters_resolved_by TO idx_event_clusters_resolved_by', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

ALTER TABLE event_clusters
  ADD CONSTRAINT fk_event_clusters_ack_by FOREIGN KEY (acknowledged_by)
    REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_event_clusters_resolved_by FOREIGN KEY (resolved_by)
    REFERENCES users (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 7) probe_outages + probe_thresholds — from 024 and 025
-- ---------------------------------------------------------------------------
ALTER TABLE probe_outages
  DROP FOREIGN KEY fk_incidents_agent;
ALTER TABLE probe_outages
  DROP FOREIGN KEY fk_incidents_location;
ALTER TABLE probe_outages
  RENAME INDEX idx_incidents_location_started TO idx_probe_outages_location_started,
  RENAME INDEX idx_incidents_resolved         TO idx_probe_outages_resolved,
  RENAME INDEX idx_incidents_active           TO idx_probe_outages_active;
ALTER TABLE probe_outages
  ADD CONSTRAINT fk_probe_outages_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_probe_outages_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE SET NULL;

ALTER TABLE probe_thresholds
  DROP FOREIGN KEY fk_incident_thresholds_location;
ALTER TABLE probe_thresholds
  RENAME INDEX uq_incident_thresholds_location_metric TO uq_probe_thresholds_location_metric;
ALTER TABLE probe_thresholds
  ADD CONSTRAINT fk_probe_thresholds_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE CASCADE;
