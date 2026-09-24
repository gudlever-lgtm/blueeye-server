-- 129 — an event case can say which situation (cross-agent cluster) it is part of.
--
-- Event cases (047) group findings PER DEVICE; situations (057, `event_clusters`)
-- group findings ACROSS agents. The two were never linked, so the same outage
-- seen from three agents was three unrelated cases on the Events list and a
-- situation nobody reached from any of them, and the per-case auto-resolve
-- closed a case whose situation was still going. The cluster sweep
-- (src/analysis/crossAgentClusterService.js) now stamps the situation onto the
-- cases of its member findings, and eventCases/autoResolveJob.js leaves a case
-- alone while its situation is still live.
--
-- Nullable: most cases are single-device and belong to no situation. ON DELETE
-- SET NULL: deleting a situation must never delete the work log of a case. The
-- type matches event_clusters.id (BIGINT UNSIGNED) exactly, which a foreign key
-- requires. The index backs "the cases of situation N" on the Situation page.

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'event_cases'
                      AND column_name = 'cluster_id'),
  'DO 0',
  'ALTER TABLE event_cases ADD COLUMN cluster_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER config_change_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'event_cases'
                      AND index_name = 'idx_event_cases_cluster'),
  'DO 0',
  'CREATE INDEX idx_event_cases_cluster ON event_cases (cluster_id)');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
                    WHERE table_schema = DATABASE() AND table_name = 'event_cases'
                      AND constraint_name = 'fk_event_cases_cluster'
                      AND constraint_type = 'FOREIGN KEY'),
  'DO 0',
  'ALTER TABLE event_cases ADD CONSTRAINT fk_event_cases_cluster FOREIGN KEY (cluster_id) REFERENCES event_clusters (id) ON DELETE SET NULL');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
