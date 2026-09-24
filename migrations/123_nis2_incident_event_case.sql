-- 123 — a NIS2 incident can say which event case it came from.
--
-- Event cases (072) are where an outage is worked: findings grouped per device,
-- a timeline, notes across shifts. A NIS2 incident is the regulator-facing
-- record of the same event. Until now the two were unrelated rows, so drafting
-- the NIS2 record meant retyping the case, and nothing on either side said the
-- other existed. `POST /api/nis2/incidents/from-event-case/:id` pre-fills the
-- draft from the case and stores the link here.
--
-- Nullable: hand-written incidents and cluster drafts have no case. ON DELETE
-- SET NULL: deleting a case must never delete the regulatory record of it —
-- the incident outlives the operational ticket by years. The type matches
-- event_cases.id (BIGINT UNSIGNED) exactly, which a foreign key requires.

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'blueeye_nis2_incidents'
                      AND column_name = 'event_case_id'),
  'DO 0',
  'ALTER TABLE blueeye_nis2_incidents ADD COLUMN event_case_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER final_report_submitted_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'blueeye_nis2_incidents'
                      AND index_name = 'idx_nis2_incidents_event_case'),
  'DO 0',
  'CREATE INDEX idx_nis2_incidents_event_case ON blueeye_nis2_incidents (event_case_id)');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
                    WHERE table_schema = DATABASE() AND table_name = 'blueeye_nis2_incidents'
                      AND constraint_name = 'fk_nis2_incidents_event_case'
                      AND constraint_type = 'FOREIGN KEY'),
  'DO 0',
  'ALTER TABLE blueeye_nis2_incidents ADD CONSTRAINT fk_nis2_incidents_event_case FOREIGN KEY (event_case_id) REFERENCES event_cases (id) ON DELETE SET NULL');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
