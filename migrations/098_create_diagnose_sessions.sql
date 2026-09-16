-- 097 — symptom-first diagnosis sessions (docs/diagnose.md).
--
-- A technician writes what is wrong in their own words, BlueEyes returns a plan
-- — likely causes, the tests to run with their parameters filled in, the views
-- to open and what to look for — and once the tests have run it evaluates the
-- playbook's reading rules and marks each cause confirmed, ruled out or still
-- open. These two tables are the session that holds that together.
--
-- `diagnose_sessions` — one row per "describe the problem". It stores the
-- description as the user wrote it, WHICH matcher produced the plan
-- (`matched_by`: 'keywords' or 'llm' — the UI has to be able to say so, because
-- a plan is worth a different amount depending on the answer) and the resolved
-- entities. `plan` is the plan as returned: the causes, their tests and their
-- views, frozen. It is frozen on purpose. A plan that silently re-derives itself
-- from an edited catalogue is a plan whose history cannot be read afterwards,
-- and this one goes in the audit log.
--
-- `diagnose_session_tests` — one row per test the plan asked for, and the
-- correlation this module needs and could not otherwise have: probe_results
-- carries no run id, so a session finds its own results by (agent, type, target,
-- ts >= dispatched_at). Storing the dispatch time per test is what makes that
-- lookup answer "the results of THIS run" rather than "whatever was measured
-- recently". `probe_result_id` is filled once a result is matched, so the
-- evidence link is exact from then on.
--
-- Deliberately NOT a new probe path: the tests are ordinary probes, run by the
-- ordinary run-probe command and reported through the ordinary endpoint. A
-- diagnosis that needed its own execution channel would be a second way for a
-- test to work, and a second way for it to break.

CREATE TABLE IF NOT EXISTS diagnose_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  description VARCHAR(1000) NOT NULL,
  locale VARCHAR(8) NOT NULL DEFAULT 'en',
  -- 'keywords' = the local matcher; 'llm' = the AI mapped it and the result
  -- validated against the catalogue. Never anything else: an LLM answer that
  -- did not validate falls back and is recorded as 'keywords'.
  matched_by ENUM('keywords', 'llm') NOT NULL DEFAULT 'keywords',
  -- The agent the tests run from, and the agent at the far end when the plan
  -- needs the question asked in both directions. Both nullable: a session can
  -- exist before the operator has picked a device.
  agent_id INT UNSIGNED NULL DEFAULT NULL,
  peer_agent_id INT UNSIGNED NULL DEFAULT NULL,
  target VARCHAR(255) NULL DEFAULT NULL,
  entities JSON NULL DEFAULT NULL,
  plan JSON NOT NULL,
  -- The last evaluation: verdicts, evidence and the RCA summary. NULL until
  -- /evaluate has run.
  evaluation JSON NULL DEFAULT NULL,
  status ENUM('planned', 'running', 'evaluated') NOT NULL DEFAULT 'planned',
  created_by VARCHAR(255) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_diagnose_sessions_created (created_at),
  KEY idx_diagnose_sessions_agent (agent_id, created_at),
  -- An agent can be deleted mid-investigation; the session and its evidence
  -- outlive it rather than vanishing with it.
  CONSTRAINT fk_diagnose_sessions_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT fk_diagnose_sessions_peer FOREIGN KEY (peer_agent_id) REFERENCES agents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS diagnose_session_tests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  playbook_id VARCHAR(64) NOT NULL,
  agent_id INT UNSIGNED NULL DEFAULT NULL,
  -- 'forward' runs from the session's agent, 'reverse' from the far end. The
  -- direction is what tells an asymmetric fault from a symmetric one, so it is a
  -- column rather than something inferred from which agent id happens to be set.
  direction ENUM('forward', 'reverse') NOT NULL DEFAULT 'forward',
  probe_type VARCHAR(16) NOT NULL,
  target VARCHAR(255) NOT NULL,
  params JSON NULL DEFAULT NULL,
  status ENUM('pending', 'dispatched', 'complete', 'failed') NOT NULL DEFAULT 'pending',
  -- The correlation window opens here. See the table note above.
  dispatched_at DATETIME NULL DEFAULT NULL,
  probe_result_id BIGINT UNSIGNED NULL DEFAULT NULL,
  detail VARCHAR(255) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_diagnose_tests_session (session_id, id),
  KEY idx_diagnose_tests_lookup (agent_id, probe_type, target, dispatched_at),
  CONSTRAINT fk_diagnose_tests_session FOREIGN KEY (session_id) REFERENCES diagnose_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_diagnose_tests_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
