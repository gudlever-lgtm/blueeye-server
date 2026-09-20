-- 107 — burst_runs: one-target, once-a-second measurement, on demand.
--
-- THE GAP THIS FILLS. Agents report on a 60-second interval and the analysis
-- baselines are hourly, so a five-second loss event is invisible. The fault a
-- technician is standing in front of, on the phone, right now, does not exist
-- in the data. A burst is not a new metric — it is a temporary resolution.
--
-- WHY THE SAMPLES ARE A JSON COLUMN AND NOT A TABLE.
--
-- A burst is at most 120 seconds at 2 Hz: 240 points, bounded, written once and
-- read as a whole. That is a small FIELD, not a time series. A row-per-sample
-- table would add a hot-path insert loop, a second retention dimension and a
-- join to every read, to store something that is never queried across runs,
-- never aggregated, and never grows after the run ends.
--
-- `probe_results` is the opposite case and stays as it is: unbounded, appended
-- forever, queried across time. The difference between the two is exactly why
-- this one is a column.
--
-- WHY THE VERDICT IS STORED. The analysis (median + MAD, and whether the losses
-- CLUSTER) is computed once, in code, from the samples — and kept, so the row
-- reads the same in a report six weeks later as it did on the screen. Same rule
-- every finding in this product follows: the explanation travels with the
-- measurement, and nothing re-derives a verdict from data that has since aged.
CREATE TABLE IF NOT EXISTS `burst_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- The agent that measured. No FK: this is telemetry, and an agent removed
  -- from the fleet must not delete the evidence of what it measured.
  `agent_id` INT UNSIGNED NOT NULL,
  `target` VARCHAR(255) NOT NULL,
  `probe` VARCHAR(16) NOT NULL DEFAULT 'ping',
  -- What was ASKED for and what was RUN can differ: the agent clamps a request
  -- beyond its caps. Storing the plan means a run that looks short is
  -- explainable rather than suspicious.
  `requested_seconds` INT UNSIGNED NULL DEFAULT NULL,
  `seconds` INT UNSIGNED NOT NULL,
  `hz` DECIMAL(4, 2) NOT NULL DEFAULT 1.00,
  `started_at` DATETIME(3) NOT NULL,
  `ended_at` DATETIME(3) NULL DEFAULT NULL,
  -- 'running' while the samples are still streaming in, so the screen can show
  -- a live run; a run whose agent went away never leaves it, which is itself
  -- the honest state.
  `status` ENUM('running', 'complete', 'cancelled', 'failed') NOT NULL DEFAULT 'running',
  `error` VARCHAR(255) NULL DEFAULT NULL,
  -- The whole series: [{ t, ok, rttMs }]. Bounded at 240 points by the agent.
  `samples` JSON NULL DEFAULT NULL,
  `sample_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `lost_count` INT UNSIGNED NOT NULL DEFAULT 0,
  -- The verdict, computed once from the samples (src/probes/burstAnalysis.js).
  -- `explanation` is the sentence a technician reads; it is the only part of
  -- this row that is worth anything on its own.
  `loss_pct` DECIMAL(5, 2) NULL DEFAULT NULL,
  `median_rtt_ms` DECIMAL(10, 3) NULL DEFAULT NULL,
  `p95_rtt_ms` DECIMAL(10, 3) NULL DEFAULT NULL,
  `jitter_ms` DECIMAL(10, 3) NULL DEFAULT NULL,
  `loss_clusters` INT UNSIGNED NULL DEFAULT NULL,
  `pattern` VARCHAR(32) NULL DEFAULT NULL,
  `explanation` VARCHAR(512) NULL DEFAULT NULL,
  `created_by` INT UNSIGNED NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_burst_runs_agent` (`agent_id`, `started_at`),
  KEY `idx_burst_runs_started` (`started_at`),
  CONSTRAINT `fk_burst_runs_user` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
