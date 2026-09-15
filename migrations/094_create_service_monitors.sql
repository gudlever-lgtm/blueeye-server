-- 094 — Service Assurance monitors: the checks that are not a browser.
--
-- Service Assurance could answer "can a user sign in and search?" because it
-- drives a browser, and "does this certificate expire?" because the reaction
-- layer reads it on its own schedule. It could not answer the questions that
-- fail silently and are only discovered when somebody complains:
--
--   * did the mail we sent actually arrive?
--   * is SPF/DKIM/DMARC still on the domain after somebody edited DNS?
--   * is our sending address on a blacklist?
--   * can people still bind to the directory / reach the database?
--   * is the clock on that host still right?
--
-- A MONITOR is one such question, asked on an interval. It is deliberately NOT
-- a service_test: a test is a list of browser intents carried out by the worker
-- process, while a monitor is a protocol exchange run in the API process, the
-- same place the certificate checker already runs. Sharing a table with tests
-- would mean either giving the DSL steps it cannot execute or giving the worker
-- runs it cannot claim.
--
-- Two tables, the same split as certificates/incidents:
--
--   service_monitors        — the definition and its CURRENT state (one row per
--                             monitor; last status, last run, failure streak).
--   service_monitor_results — one row per check. This one IS history: "the mail
--                             took 4 s yesterday and 90 s today" is the finding,
--                             and it cannot be seen in a state row.
--
-- Secrets (an SMTP password, a bind password) live in `secrets_encrypted` as one
-- AES-256-GCM blob through the same secretBox the credentials table uses, and no
-- read path outside the checker ever decrypts it — same rule as migration 078.
--
-- Module rules as before: `service_` prefix, no foreign keys across the module
-- boundary, tenant_id present-but-unused, no DEFAULT on a JSON column (MySQL 8.4).

-- ------------------------------------------------------------------ monitors
-- `type` is a plain VARCHAR rather than an ENUM on purpose: the catalogue lives
-- in src/serviceTests/monitors/types.js, and a new check type must be able to
-- ship without a migration. The validator refuses anything not in the catalogue,
-- so the openness is at the storage layer only.
--
-- `target` is the one address the check is ABOUT — the mail server, the domain,
-- the directory host. It is denormalised out of `config` so the list screen and
-- the incident subject can name it without parsing JSON.
--
-- `consecutive_failures` is kept on the row instead of counted from the results
-- table on every sweep. The sweep asks the question for every monitor on every
-- pass; a COUNT over history per monitor per pass is a scan we would pay for
-- forever to learn a number the write already knew.
CREATE TABLE IF NOT EXISTS service_monitors (
  id             INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT               DEFAULT NULL,
  -- Optional. A monitor may belong to an application (so its incidents group
  -- with that service's) or stand alone — "is our mail flowing" is about the
  -- estate, not about one registered web application.
  application_id INT               DEFAULT NULL,
  environment_id INT               DEFAULT NULL,
  name           VARCHAR(255)  NOT NULL,
  type           VARCHAR(32)   NOT NULL,
  target         VARCHAR(255)  NOT NULL,
  description    TEXT              DEFAULT NULL,
  config         JSON          NOT NULL,
  secrets_encrypted TEXT           DEFAULT NULL,
  interval_sec   INT           NOT NULL DEFAULT 900,
  -- Thresholds in milliseconds, on whatever the check MEASURES (delivery time,
  -- bind time, |clock offset|). NULL means "no threshold" — a check that has no
  -- meaningful duration still has an ok/failed verdict.
  warn_ms        INT               DEFAULT NULL,
  crit_ms        INT               DEFAULT NULL,
  enabled        TINYINT(1)    NOT NULL DEFAULT 1,
  last_run_at    DATETIME(3)       DEFAULT NULL,
  last_status    VARCHAR(24)       DEFAULT NULL,
  last_summary   VARCHAR(512)      DEFAULT NULL,
  last_duration_ms INT             DEFAULT NULL,
  consecutive_failures INT     NOT NULL DEFAULT 0,
  created_by     INT               DEFAULT NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_smon_name (name),
  INDEX idx_smon_due (enabled, last_run_at),
  INDEX idx_smon_app (application_id),
  INDEX idx_smon_type (type),
  CONSTRAINT fk_smon_app FOREIGN KEY (application_id)
    REFERENCES service_test_applications(id) ON DELETE SET NULL,
  CONSTRAINT fk_smon_env FOREIGN KEY (environment_id)
    REFERENCES service_test_environments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------------- results
-- `status` is the verdict vocabulary EVERY check type shares, so one list screen
-- and one policy can read them all:
--   ok            — the question was answered and the answer was good
--   slow          — good, but over the operator's warning threshold
--   failed        — the check ran and the answer was bad (mail rejected, record
--                   missing, address listed, bind refused)
--   unreachable   — nothing answered; there is no answer to judge
--   misconfigured — the MONITOR cannot run (missing credential, absent driver).
--                   Ours to fix, never the monitored service's, and policy.js
--                   never escalates it past WARN for exactly that reason
--   unknown       — a verdict could not be formed
--
-- `kind` is the finer-grained reason an incident carries (mail_undelivered,
-- dns_record_missing, …). Same split as runs: status is what a list shows, kind
-- is what the reaction layer decides on.
--
-- `timings` holds the per-phase milliseconds (connect / tls / auth / accept /
-- delivery). The phase is the diagnosis: "accepted in 140 ms, delivered after
-- 90 s" says the queue is backed up, and a single total would not.
CREATE TABLE IF NOT EXISTS service_monitor_results (
  id             BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT               DEFAULT NULL,
  monitor_id     INT           NOT NULL,
  status         ENUM('ok','slow','failed','unreachable','misconfigured','unknown')
                 NOT NULL DEFAULT 'unknown',
  kind           VARCHAR(48)       DEFAULT NULL,
  duration_ms    INT               DEFAULT NULL,
  -- The measurement the check exists to take, with its unit: delivery seconds,
  -- clock offset in ms, days remaining on a certificate.
  value          DOUBLE            DEFAULT NULL,
  unit           VARCHAR(16)       DEFAULT NULL,
  summary        VARCHAR(512)      DEFAULT NULL,
  error_message  TEXT              DEFAULT NULL,
  timings        JSON              DEFAULT NULL,
  detail         JSON              DEFAULT NULL,
  trigger_source ENUM('schedule','manual') NOT NULL DEFAULT 'schedule',
  requested_by   INT               DEFAULT NULL,
  checked_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_smonr_monitor (monitor_id, checked_at),
  INDEX idx_smonr_status (status, checked_at),
  CONSTRAINT fk_smonr_monitor FOREIGN KEY (monitor_id)
    REFERENCES service_monitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A monitor is a third kind of incident subject. Re-running this statement is a
-- no-op, which is what the twice-applied migration chain requires.
ALTER TABLE service_test_incidents
  MODIFY COLUMN subject_type ENUM('test','certificate','monitor') NOT NULL;
