-- Self-healing selectors (V2 §5, P2 #7).
--
--     Original:   #login-button
--     Suggested:  button "Log ind"
--
-- When a step's target no longer resolves, BlueEyes proposes the element it
-- thinks the operator meant. It does NOT repoint the test: the spec says
-- "testen må ikke ændres automatisk uden brugerens accept", and this table is
-- how that rule is kept honest — a proposal is a row somebody has to act on,
-- not a change that happened while they were asleep.
--
-- It is also the log the spec asks for ("log ændringerne"). The row survives the
-- decision: `status` records what the operator did, `applied_by` who did it, and
-- `original_target` what the test used to say. So "why does this test point at a
-- different button than it did in March" has an answer six months later.
CREATE TABLE service_test_healing (
  id             INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT               DEFAULT NULL,
  test_id        INT           NOT NULL,
  -- The run that found it. Kept so the proposal can be read beside the failure
  -- and the screenshot that produced it.
  run_id         INT               DEFAULT NULL,
  -- Which step, by the flattened PATH the engine hands out ("0", or "2.1" for
  -- the second step inside the block at index 2). A path rather than an index
  -- because a step inside a condition block has no index of its own — and a
  -- proposal that could only ever address top-level steps would quietly not
  -- work on exactly the tests that are complicated enough to break.
  --
  -- The definition can still change underneath a pending proposal, which is why
  -- accepting re-checks that the step at this path still SAYS what the proposal
  -- was made against.
  step_path      VARCHAR(40)   NOT NULL,
  step_type      VARCHAR(40)       DEFAULT NULL,
  -- The hint bags: what the test said, and what BlueEyes found.
  original_target JSON         NOT NULL,
  proposed_target JSON         NOT NULL,
  confidence     ENUM('high','medium','low') NOT NULL DEFAULT 'low',
  -- The sentence the operator reads. Stored rather than recomputed: the page it
  -- describes will have changed again by the time anyone reads the history.
  reason         TEXT              DEFAULT NULL,
  score          INT               DEFAULT NULL,
  status         ENUM('proposed','accepted','rejected','stale') NOT NULL DEFAULT 'proposed',
  applied_by     INT               DEFAULT NULL,
  decided_at     DATETIME(3)       DEFAULT NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sth_test (test_id, status),
  INDEX idx_sth_step (test_id, step_path, status),
  INDEX idx_sth_run (run_id),
  CONSTRAINT fk_sth_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_sth_run FOREIGN KEY (run_id) REFERENCES service_test_runs(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
