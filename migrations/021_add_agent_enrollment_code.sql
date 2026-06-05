-- 021 — link each agent to the enrollment code it was created with, so the
-- Enrollment page can show the live availability of the agent(s) a code enrolled
-- (a bulk code can enroll several). ON DELETE SET NULL: deleting a spent code
-- must never break a running agent — its opaque token is independent and stays
-- valid until revoked. NULL = enrolled before this migration (or code deleted).
ALTER TABLE agents
  ADD COLUMN enrollment_code_id INT UNSIGNED NULL DEFAULT NULL AFTER location_id,
  ADD KEY idx_agents_enrollment_code_id (enrollment_code_id),
  ADD CONSTRAINT fk_agents_enrollment_code FOREIGN KEY (enrollment_code_id)
    REFERENCES enrollment_codes (id) ON DELETE SET NULL;
