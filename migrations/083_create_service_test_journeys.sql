-- Service Assurance — User Journeys / Business Transactions (V2 §2, P1 #1).
--
-- The central object the spec asks for: a complete function seen from the USER'S
-- side, not from the monitoring system's.
--
--     Customer Login → Search Customer → Open Customer → Verify Details → Logout
--
-- Each arrow is a test that already exists. The journey is what makes the set of
-- them mean something: "can a caseworker do their job", rather than five
-- unrelated green ticks.
--
-- WHAT THIS DELIBERATELY IS NOT: a second test model. A journey owns no steps of
-- its own, no definition, no DSL. It ORDERS tests, and everything that executes
-- is still a test — so every V1 feature (the designer, the runner, history,
-- screenshots, incidents, recording) works inside a journey on day one without
-- being taught about journeys at all.
--
-- The ordering is the journey's, not the test's: the same "Login" test can be
-- step 1 of three different journeys, which is the normal case and the reason
-- membership is its own table rather than a column on the test.

CREATE TABLE service_test_journeys (
  id             INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT               DEFAULT NULL,
  application_id INT           NOT NULL,
  name           VARCHAR(255)  NOT NULL,
  description    TEXT              DEFAULT NULL,
  -- What it costs the business when this journey is broken. NOT a severity the
  -- system computes — a judgement the customer makes once, which then decides
  -- how loudly a failure is reported and where it appears.
  criticality    ENUM('critical','high','normal','low') NOT NULL DEFAULT 'normal',
  -- What "normal" looks like, in the operator's own words, before any statistics
  -- exist. Milliseconds. NULL means "no expectation stated" — which is honest,
  -- and different from zero.
  expected_duration_ms INT         DEFAULT NULL,
  -- Which environment this journey describes. A journey is about production
  -- unless it says otherwise; staging gets its own journey rather than a flag.
  environment_id INT               DEFAULT NULL,
  enabled        TINYINT(1)    NOT NULL DEFAULT 1,
  created_by     INT               DEFAULT NULL,
  updated_by     INT               DEFAULT NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stj_app (application_id, enabled),
  INDEX idx_stj_criticality (criticality),
  CONSTRAINT fk_stj_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_stj_env FOREIGN KEY (environment_id) REFERENCES service_test_environments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which tests make up a journey, in order.
--
-- `required` is the distinction between "the service is broken" and "part of it
-- is": a failing required step fails the journey; a failing optional one degrades
-- it. Logout failing is not the same event as Login failing, and a monitoring
-- system that cannot say so makes its own alerts worthless.
CREATE TABLE service_test_journey_steps (
  id             INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  journey_id     INT           NOT NULL,
  test_id        INT           NOT NULL,
  position       INT           NOT NULL,
  -- The journey's own name for this step ("Search Customer"), when the test's
  -- name is not what the journey wants to call it. NULL = use the test's name.
  label          VARCHAR(255)      DEFAULT NULL,
  required       TINYINT(1)    NOT NULL DEFAULT 1,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- One test appears at most once in one journey; the same test may appear in
  -- many journeys, which is the point of this table existing.
  UNIQUE KEY uq_stjs_journey_test (journey_id, test_id),
  INDEX idx_stjs_order (journey_id, position),
  INDEX idx_stjs_test (test_id),
  CONSTRAINT fk_stjs_journey FOREIGN KEY (journey_id) REFERENCES service_test_journeys(id) ON DELETE CASCADE,
  CONSTRAINT fk_stjs_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
