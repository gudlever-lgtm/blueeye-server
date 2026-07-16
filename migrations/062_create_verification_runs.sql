-- 062 — verification runs: the "did the fix actually work?" cycle (Fase 3).
--
-- Today a playbook run is logged but nothing re-checks that the original symptoms
-- cleared. When an operator runs a playbook against the targets of an open
-- incident cluster, we record a verification run: after a configurable settle
-- time (default 5 min) a leader-only sweep re-checks the cluster's affected
-- targets for fresh findings of the relevant finding-types, and records the
-- outcome — WITHOUT ever auto-resolving the cluster (clustering informs; humans
-- decide).
--
--   status: pending  — scheduled, settle window not yet elapsed / not yet checked
--           passed    — no fresh symptoms on the affected targets → suggest resolve
--           failed    — symptoms persist → cluster stays open, retry logic (if any)
--           error     — the re-check could not run (surfaced, never silent)
--
-- affected_targets / finding_types are JSON snapshots taken at execution time so
-- the re-check is deterministic even if the cluster changes afterwards. readings
-- holds the fresh findings observed on a failed check (evidence, not a black box).
CREATE TABLE IF NOT EXISTS verification_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cluster_id BIGINT UNSIGNED NOT NULL,
  playbook_id INT UNSIGNED NULL DEFAULT NULL,
  runbook_id INT UNSIGNED NULL DEFAULT NULL,
  triggered_by VARCHAR(190) NULL DEFAULT NULL,      -- user email or 'system'
  affected_targets JSON NOT NULL,                   -- agent ids (strings) snapshot
  finding_types JSON NOT NULL,                       -- metrics to re-check
  settle_seconds INT UNSIGNED NOT NULL,
  executed_at DATETIME NOT NULL,                     -- when the playbook was run
  due_at DATETIME NOT NULL,                          -- executed_at + settle
  status ENUM('pending', 'passed', 'failed', 'error') NOT NULL DEFAULT 'pending',
  readings JSON NULL DEFAULT NULL,                   -- fresh findings on a failed re-check
  completed_at DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_verification_runs_due (status, due_at),
  KEY idx_verification_runs_cluster (cluster_id, executed_at),
  CONSTRAINT fk_verification_runs_cluster FOREIGN KEY (cluster_id)
    REFERENCES incident_clusters (id) ON DELETE CASCADE,
  CONSTRAINT fk_verification_runs_playbook FOREIGN KEY (playbook_id)
    REFERENCES remediation_playbooks (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
