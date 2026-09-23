-- 122 — the NIS2 Article 23 fields an incident notification actually asks for,
-- and WHEN each report went to the authority.
--
-- Art. 23(4) spells out what the notifications contain, and the register could
-- not hold three of them:
--
--   (a) the early warning must say whether the incident is SUSPECTED of being
--       caused by an unlawful or malicious act, and whether it could have a
--       CROSS-BORDER impact;
--   the notification/final report are sent to a CSIRT or competent authority,
--       which answers with its own case reference — the one thing every later
--       exchange quotes.
--
-- And the deadlines (24 h early warning / 72 h notification / one-month final
-- report, src/nis2/deadlines.js) could only ever be 'upcoming', 'due-soon' or
-- 'overdue': nothing recorded that a report had been SENT, so an incident that
-- was reported on time read as overdue forever. The three submission
-- timestamps are what let a stage be 'submitted' (on time or late).
--
-- All nullable / defaulted, so every existing incident keeps its meaning: not
-- suspected, no cross-border impact recorded, nothing submitted yet.

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'blueeye_nis2_incidents'
                      AND column_name = 'suspected_malicious'),
  'DO 0',
  'ALTER TABLE blueeye_nis2_incidents ADD COLUMN suspected_malicious TINYINT(1) NOT NULL DEFAULT 0 AFTER notification_required');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'blueeye_nis2_incidents'
                      AND column_name = 'cross_border_impact'),
  'DO 0',
  'ALTER TABLE blueeye_nis2_incidents ADD COLUMN cross_border_impact TINYINT(1) NOT NULL DEFAULT 0 AFTER suspected_malicious');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'blueeye_nis2_incidents'
                      AND column_name = 'cross_border_details'),
  'DO 0',
  'ALTER TABLE blueeye_nis2_incidents ADD COLUMN cross_border_details TEXT NULL DEFAULT NULL AFTER cross_border_impact');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'blueeye_nis2_incidents'
                      AND column_name = 'authority_reference'),
  'DO 0',
  'ALTER TABLE blueeye_nis2_incidents ADD COLUMN authority_reference VARCHAR(128) NULL DEFAULT NULL AFTER cross_border_details');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'blueeye_nis2_incidents'
                      AND column_name = 'early_warning_submitted_at'),
  'DO 0',
  'ALTER TABLE blueeye_nis2_incidents ADD COLUMN early_warning_submitted_at DATETIME NULL DEFAULT NULL AFTER authority_reference');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'blueeye_nis2_incidents'
                      AND column_name = 'notification_submitted_at'),
  'DO 0',
  'ALTER TABLE blueeye_nis2_incidents ADD COLUMN notification_submitted_at DATETIME NULL DEFAULT NULL AFTER early_warning_submitted_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'blueeye_nis2_incidents'
                      AND column_name = 'final_report_submitted_at'),
  'DO 0',
  'ALTER TABLE blueeye_nis2_incidents ADD COLUMN final_report_submitted_at DATETIME NULL DEFAULT NULL AFTER notification_submitted_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
