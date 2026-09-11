-- Discovery → Journey suggestions (V2 §3, P1 #3).
--
-- Discovery already proposes TESTS. A test suggestion answers "what could we
-- check here"; it does not answer the question the product exists to answer,
-- which is "what does a user actually DO here". A journey suggestion does:
--
--     Suggested journey · Sign in and use the application
--       1. Login                      required
--       2. Authenticated navigation   required
--       3. Logout                     optional
--     Confidence: medium
--     Reason: found a login flow and reached 3 pages behind it.
--
-- Rather than a second suggestions table, the existing one grows a `kind`. The
-- accept/dismiss flow, the discovery link and the statuses already exist and
-- behave identically for both kinds; duplicating them would mean two places to
-- forget to update.
--
-- A journey suggestion names its members by the NAME of the test suggestions
-- beside it, because those tests do not exist yet — nothing has been accepted.
-- Accepting the journey is what creates them. That is the spec's chain:
-- Discovery → suggested journey → user accepts → tests created → runs →
-- results become evidence.
ALTER TABLE service_test_suggestions
  ADD COLUMN kind ENUM('test','journey') NOT NULL DEFAULT 'test' AFTER application_id,
  -- { criticality, expected_duration_ms, steps: [{ suggestion_name, required }] }
  -- NULL for a test suggestion. MySQL 8.4: a JSON column takes no default.
  ADD COLUMN proposed_journey JSON DEFAULT NULL AFTER proposed_steps,
  -- Set when a journey suggestion is accepted, the way `created_test_id` is for
  -- a test suggestion — so "already handled" means the same thing for both.
  ADD COLUMN created_journey_id INT DEFAULT NULL AFTER created_test_id,
  ADD CONSTRAINT fk_stsug_journey FOREIGN KEY (created_journey_id)
    REFERENCES service_test_journeys(id) ON DELETE SET NULL;

CREATE INDEX idx_stsug_kind ON service_test_suggestions (application_id, kind, status);
