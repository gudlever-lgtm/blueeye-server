-- 100 — reports that arrive on their own.
--
-- The availability and probe-outage reports are exports: somebody opens the
-- Reporting page, picks a period and downloads a file. That is the right shape
-- for answering a question, and the wrong shape for the recurring obligation
-- those two reports usually serve — the monthly SLA figure for a customer, the
-- weekly outage list for a service review. A report nobody remembers to pull is
-- a report that is missing on the day it is asked for.
--
-- A schedule says WHICH report, over how long a window, for whom, and how often:
--
--   report        'availability' | 'probe_outages' — the two the exports cover
--   format        'csv' | 'html' — the same two renderings, as an attachment
--   window_days   the period is RELATIVE and computed at fire time ("the last
--                 7 days"), never a stored from/to, which would send the same
--                 fortnight forever
--   params        the report's own filters (location_id, severity)
--   schedule_spec the recurrence from migration 099 — the same calendar the
--                 test packages use, so "the 1st at 06:00" means one thing in
--                 this product
--   recipients    who it goes to; delivery is the alerting SMTP settings, so an
--                 admin configures a mail server once
--
-- last_run_at / last_run_status are the honest half: a schedule that has been
-- failing to send for three weeks must say so on the screen that created it,
-- rather than looking healthy because nothing threw where anyone could see.
CREATE TABLE IF NOT EXISTS `report_schedules` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `report` VARCHAR(32) NOT NULL,
  `format` VARCHAR(8) NOT NULL DEFAULT 'csv',
  `window_days` SMALLINT UNSIGNED NOT NULL DEFAULT 7,
  `params` JSON NULL DEFAULT NULL,
  `schedule_spec` JSON NOT NULL,
  `recipients` JSON NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` VARCHAR(255) NULL DEFAULT NULL,
  `last_run_at` DATETIME NULL DEFAULT NULL,
  `last_run_status` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_report_schedules_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
