-- 072 — the incident work log (shift handover).
--
-- Intermittent faults run across several shifts. Today nothing survives the
-- handover: agents.notes is overwritten on every PUT, incident_clusters carries a
-- single resolution_note set once at resolve time, findings.acked is a bare
-- boolean with no author and no timestamp, and the comment required to reopen an
-- incident lands only in audit_log.detail. None of that is a log.
--
-- This table is that log. It hangs off incident_cases (migration 047) — the
-- first-class incident the operator actually works, NOT the probe-outage
-- `incidents` of migration 025 and NOT incident_clusters.
--
-- APPEND-ONLY BY CONSTRUCTION. There is no updated_at, no edited_by and no
-- soft-delete column, because the repository exposes no UPDATE and no DELETE:
-- the shape of the table is the contract. A correction is a new entry, which is
-- what you want anyway — the next shift needs to see that something WAS believed
-- and then revised, not a tidied-up final answer.
--
-- `kind` splits the log three ways so the UI can pin the one that matters:
--   observation — something the operator saw
--   action      — something the operator changed or ran
--   ruled_out   — a cause the operator has EXCLUDED
--
-- ruled_out is why this table exists. It is indexed separately (idx_incident_
-- notes_ruled_out) so "what has already been excluded" is one cheap query, and
-- it renders pinned at the top of the panel: it is the first thing the next
-- shift must read, so they do not re-test what someone already disproved.
--
-- author_user_id is nullable with ON DELETE SET NULL (a leaving employee must not
-- take the incident history with them), so author_email/author_role are
-- denormalised snapshots that survive the user row — the same trick audit_log
-- (migration 033) uses.
CREATE TABLE IF NOT EXISTS incident_notes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  incident_case_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('observation', 'action', 'ruled_out') NOT NULL,
  text VARCHAR(4000) NOT NULL,
  author_user_id INT UNSIGNED NULL DEFAULT NULL,
  author_email VARCHAR(255) NULL DEFAULT NULL,   -- snapshot; outlives the user row
  author_role VARCHAR(32) NULL DEFAULT NULL,     -- snapshot; the role held when written
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The panel's default read: one incident, oldest-first (chronological).
  KEY idx_incident_notes_case (incident_case_id, created_at),
  -- "What is already ruled out?" without scanning the whole log.
  KEY idx_incident_notes_ruled_out (incident_case_id, kind, created_at),
  CONSTRAINT fk_incident_notes_case FOREIGN KEY (incident_case_id)
    REFERENCES incident_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_incident_notes_author FOREIGN KEY (author_user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
