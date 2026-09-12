-- 092 — AI analyses (V3 Phase 4, docs/service-assurance-v3.md §"AI").
--
-- One row per answer a provider gave, kept with THE EXACT CONTEXT it was given.
--
-- That second half is the point of the table. An AI answer is a suggestion, and
-- a suggestion nobody can check is one that gets believed. "Why did it say
-- that?" has to be answerable next month, when the incident has been resolved,
-- the runs have aged out and the service has been fixed twice — so the context
-- is stored verbatim rather than as a pointer at data that will have moved on.
--
-- What is NOT here, deliberately:
--   * no provider key, and no provider URL — those live in app_settings, and
--     copying them per row would put a credential in the history of every
--     analysis;
--   * no prompt template — it is code, it is in git, and storing it per row
--     would make this table the place people edit prompts;
--   * no raw incident. The context column holds what src/serviceTests/ai/
--     context.js allowed through, which is an allowlist, never a copy.
CREATE TABLE IF NOT EXISTS service_ai_analyses (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,

  -- What it is about. Nullable because a suggestion can be about an application
  -- rather than one incident, and NOT a foreign key onto the incident: an
  -- analysis outlives the incident it explains, and losing the record of what a
  -- provider was told because somebody purged an old incident is the one thing
  -- this table exists to prevent.
  incident_id INT DEFAULT NULL,
  application_id INT DEFAULT NULL,

  -- Which task was asked. Open text rather than an ENUM for the same reason the
  -- observation kinds are: tasks are added by shipping code, not by migrating.
  kind VARCHAR(64) NOT NULL,

  -- The answer, as prose. Capped in the application at 4000 characters; the
  -- column is larger so a cap change does not need a migration.
  answer TEXT NOT NULL,

  -- Which model produced it. An answer from a model that has since been retired
  -- is still an answer, and knowing which one wrote it is how a disagreement
  -- between two analyses gets explained.
  model VARCHAR(120) DEFAULT NULL,

  -- The evidence, exactly as sent.
  context JSON DEFAULT NULL,

  -- How long the provider took. The only metric worth keeping per row: it is
  -- what tells an operator whether the feature is worth having on.
  duration_ms INT DEFAULT NULL,

  -- Who asked. NULL for anything the system asked for on its own.
  requested_by INT DEFAULT NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  -- The only queries this table serves: the analyses of one incident, newest
  -- first, and a retention sweep by age.
  KEY idx_ai_incident (incident_id, created_at),
  KEY idx_ai_application (application_id, created_at),
  KEY idx_ai_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
