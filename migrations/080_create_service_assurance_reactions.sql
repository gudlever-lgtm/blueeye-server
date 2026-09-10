-- BlueEye Service Assurance — certificates and incidents (the reaction layer).
--
-- Until now the module only NOTICED a broken service: a scheduled test failed,
-- the failure was classified ("The TLS certificate — expired, self-signed, or
-- issued for a different name") and the run row was written. Nothing acted on
-- it, and nothing looked at a certificate until it had already broken a test —
-- which is the day after it should have been renewed.
--
-- Two tables close that gap:
--
--   service_test_certificates — what the TLS certificate on each application's
--     own address looks like RIGHT NOW: who issued it, when it expires, how many
--     days are left. Polled on its own schedule, independent of whether any test
--     is scheduled against that address.
--
--   service_test_incidents — the durable "something is wrong and here is since
--     when" record. One open row per subject (a test, or a host's certificate),
--     opened when the condition holds, escalated when it worsens, resolved when
--     the next observation is healthy. The row is what an alert is sent FROM, so
--     an alert is sent once per state change rather than once per failing run.
--
-- Same rules as migration 078: `service_test_` prefix, no foreign keys across the
-- module boundary, tenant_id present-but-unused on the query roots, and no
-- DEFAULT on a JSON column (MySQL 8.4).
--
-- The certificate table's keys are prefixed `stcert`, not `stc`. InnoDB foreign
-- key constraint names are SCHEMA-global, not per-table, and `fk_stc_app` was
-- already taken by service_test_credentials in migration 078 — this file shipped
-- once with that collision and failed on its first statement with "Duplicate
-- foreign key constraint name". Nothing was created and no schema_migrations row
-- was written, so it is corrected here rather than superseded by an 081 that
-- would have to repair a table that never existed. test/schemaSnapshot.test.js
-- now sweeps the whole schema for a repeat.

-- ---------------------------------------------------------------- certificates
-- One row per (application, host, port). Two environments on the same host share
-- one certificate, so they share one row — `environment_id` records which
-- environment introduced the target and is informational only.
--
-- `status` is the verdict at `checked_at`:
--   ok          — valid, and more than the warning window remains
--   expiring    — valid, but inside the warning window
--   expired     — notAfter is in the past
--   invalid     — the peer answered but the chain/hostname did not verify
--   unreachable — nothing answered (DNS, refused, timeout)
CREATE TABLE service_test_certificates (
  id             INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT               DEFAULT NULL,
  application_id INT           NOT NULL,
  environment_id INT               DEFAULT NULL,
  host           VARCHAR(255)  NOT NULL,
  port           INT           NOT NULL DEFAULT 443,
  url            VARCHAR(1024)     DEFAULT NULL,
  subject        VARCHAR(512)      DEFAULT NULL,
  issuer         VARCHAR(512)      DEFAULT NULL,
  serial_number  VARCHAR(128)      DEFAULT NULL,
  fingerprint    VARCHAR(190)      DEFAULT NULL,
  alt_names      TEXT              DEFAULT NULL,
  valid_from     DATETIME          DEFAULT NULL,
  valid_to       DATETIME          DEFAULT NULL,
  days_remaining INT               DEFAULT NULL,
  status         ENUM('ok','expiring','expired','invalid','unreachable') NOT NULL DEFAULT 'ok',
  error_message  TEXT              DEFAULT NULL,
  checked_at     DATETIME(3)       DEFAULT NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stcert_target (application_id, host, port),
  INDEX idx_stcert_status (status, valid_to),
  INDEX idx_stcert_checked (checked_at),
  CONSTRAINT fk_stcert_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_stcert_env FOREIGN KEY (environment_id) REFERENCES service_test_environments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- incidents
-- `subject_key` is the dedup identity: `test:<id>` or
-- `certificate:<application_id>:<host>:<port>`.
-- There is at most one row with status='open' per subject_key; the resolved rows
-- stay as history, which is why the uniqueness is enforced by the reactor's
-- lookup (indexed below) rather than by a UNIQUE KEY that would also collapse
-- every past incident into one.
--
-- `notified_severity` records the severity an alert was last SENT for, so an
-- incident that escalates WARN → CRIT notifies again while one that merely keeps
-- failing does not.
CREATE TABLE service_test_incidents (
  id                INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id         INT              DEFAULT NULL,
  application_id    INT              DEFAULT NULL,
  environment_id    INT              DEFAULT NULL,
  test_id           INT              DEFAULT NULL,
  subject_type      ENUM('test','certificate') NOT NULL,
  subject_key       VARCHAR(190) NOT NULL,
  subject_label     VARCHAR(255)     DEFAULT NULL,
  kind              VARCHAR(60)  NOT NULL,
  severity          ENUM('INFO','WARN','CRIT') NOT NULL DEFAULT 'WARN',
  status            ENUM('open','resolved') NOT NULL DEFAULT 'open',
  summary           TEXT             DEFAULT NULL,
  likely_cause      VARCHAR(255)     DEFAULT NULL,
  explanation       TEXT             DEFAULT NULL,
  evidence          JSON             DEFAULT NULL,
  occurrences       INT          NOT NULL DEFAULT 1,
  opened_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at       DATETIME(3)      DEFAULT NULL,
  resolved_by       INT              DEFAULT NULL,
  resolution        VARCHAR(255)     DEFAULT NULL,
  notified_at       DATETIME(3)      DEFAULT NULL,
  notified_severity ENUM('INFO','WARN','CRIT') DEFAULT NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sti_open (subject_key, status),
  INDEX idx_sti_status (status, severity, last_seen_at),
  INDEX idx_sti_app (application_id, status),
  CONSTRAINT fk_sti_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_sti_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
