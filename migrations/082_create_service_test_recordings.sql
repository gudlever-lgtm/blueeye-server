-- Service Assurance — recorded sessions (V2 §1).
--
-- The operator drives their own browser through a journey; the recorder script
-- observes and posts what it saw here; the translation layer
-- (src/serviceTests/recording/translate.js) turns it into the EXISTING DSL and
-- the designer opens it like any other test. The recording is scaffolding: it
-- exists between "start recording" and "save as a test", and nothing else in the
-- module reads it.
--
-- WHAT IS NOT STORED is the point. The recorder never transmits a password
-- field's value — the field is reported with `value: null` and the translation
-- turns it into `{{credential.password}}` — so a secret never crosses the
-- network, never reaches a log, and cannot be in this table to leak.
--
-- `token_hash` is SHA-256 of the capture token, never the token itself. The
-- token is shown once, in the bookmarklet, and lives minutes: if this table
-- leaks, what leaks is a hash of a credential that already expired. Same
-- reasoning as a password column, for the same reason.
--
-- `expires_at` is enforced on every ingest. A recording nobody finished is not a
-- capture endpoint left open on the internet indefinitely.
--
-- MySQL 8.4 note: JSON columns must NOT carry a non-NULL DEFAULT.
CREATE TABLE service_test_recordings (
  id             INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT               DEFAULT NULL,
  application_id INT           NOT NULL,
  name           VARCHAR(255)  NOT NULL,
  -- recording → the bookmarklet may post; stopped → it may not; accepted → a
  -- test was created from it and `created_test_id` says which.
  status         ENUM('recording','stopped','accepted') NOT NULL DEFAULT 'recording',
  token_hash     CHAR(64)      NOT NULL,
  -- The raw observations, exactly as the browser reported them. Kept rather than
  -- only the translated steps so a better translation can be re-run over an old
  -- recording without asking the operator to perform the journey again.
  events         JSON              DEFAULT NULL,
  event_count    INT           NOT NULL DEFAULT 0,
  base_url       VARCHAR(1024)     DEFAULT NULL,
  created_test_id INT              DEFAULT NULL,
  created_by     INT               DEFAULT NULL,
  expires_at     DATETIME(3)   NOT NULL,
  last_event_at  DATETIME(3)       DEFAULT NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_str_app (application_id, status),
  INDEX idx_str_expiry (expires_at),
  CONSTRAINT fk_strec_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_strec_test FOREIGN KEY (created_test_id) REFERENCES service_test_tests(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
