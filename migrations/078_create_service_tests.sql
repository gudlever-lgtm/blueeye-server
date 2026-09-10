-- Service Tests V1 — data model (docs/service-assurance.md, phases 1-2).
--
-- A no-code module: register a web application, run Discovery, accept suggested
-- tests, build them with drag & drop, run them on a Playwright worker, see why
-- they failed, schedule them. Every table is prefixed `service_test_` and there
-- are NO foreign keys in either direction between these tables and the existing
-- BlueEye schema — the module is designed to be lifted out and run standalone
-- (docs/service-assurance.md §2), and a cross-schema FK would nail it down.
--
-- Foreign keys WITHIN the module are used and cascade from the owning row, so
-- deleting an application takes its environments, credentials, allowlist, tests,
-- runs and discoveries with it.
--
-- tenant_id: nullable and UNUSED in V1. BlueEye is single-tenant on-prem and this
-- migration introduces no tenant system (spec §27) — the column exists on the
-- query-root tables only, so a later multi-tenant deployment has somewhere to put
-- the discriminator without a table rewrite. Pure child tables (steps, versions,
-- pages, elements) reach their tenant through their parent and carry none.
--
-- MySQL 8.4 note: JSON columns must NOT carry a DEFAULT (see commit 8bc21f0).

-- ---------------------------------------------------------------- settings
-- Runtime-editable module settings, key/JSON, mirroring `app_settings`. Every
-- Service Tests limit (discovery budgets, allowlist caps, runner timeouts,
-- artefact retention) is stored HERE rather than in env vars, so an operator can
-- change it without a redeploy. Code holds the defaults; a row is an override.
-- Module-owned rather than a key in `app_settings` so extraction stays clean.
CREATE TABLE service_test_settings (
  setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
  value       JSON         NOT NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by  INT              DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- applications
CREATE TABLE service_test_applications (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT              DEFAULT NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT             DEFAULT NULL,
  base_url    VARCHAR(1024) NOT NULL,
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  created_by  INT              DEFAULT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sta_enabled (enabled),
  INDEX idx_sta_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- environments
CREATE TABLE service_test_environments (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT              DEFAULT NULL,
  application_id INT          NOT NULL,
  name           VARCHAR(255) NOT NULL,
  base_url       VARCHAR(1024) NOT NULL,
  type           ENUM('production','staging','development','test','custom') NOT NULL DEFAULT 'custom',
  enabled        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ste_app_name (application_id, name),
  INDEX idx_ste_app (application_id),
  CONSTRAINT fk_ste_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- credentials
-- `secret_encrypted` is an AES-256-GCM blob written by src/lib/secretBox.js. It
-- is decrypted ONLY inside the worker, at execution time. No read path on the
-- repository returns it, and no API response, log line or screenshot may contain
-- the plaintext (docs/service-assurance.md §6).
CREATE TABLE service_test_credentials (
  id               INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id        INT              DEFAULT NULL,
  application_id   INT          NOT NULL,
  label            VARCHAR(255) NOT NULL,
  username         VARCHAR(255)     DEFAULT NULL,
  secret_encrypted TEXT             DEFAULT NULL,
  created_by       INT              DEFAULT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stc_app_label (application_id, label),
  INDEX idx_stc_app (application_id),
  CONSTRAINT fk_stc_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- host allowlist
-- The SSRF escape hatch (docs/service-assurance.md §6). Empty by default: nothing
-- beyond the application's own base-URL host is reachable until an admin adds a
-- row. An entry is a hostname, a single IP or a CIDR segment. Loopback,
-- link-local and cloud-metadata addresses are refused at write time and can
-- never appear here, whatever the privilege level.
CREATE TABLE service_test_allowed_hosts (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT              DEFAULT NULL,
  application_id INT          NOT NULL,
  entry_type     ENUM('host','ip','cidr') NOT NULL,
  value          VARCHAR(255) NOT NULL,
  note           VARCHAR(255)     DEFAULT NULL,
  created_by     INT              DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stah_app_value (application_id, value),
  INDEX idx_stah_app (application_id),
  CONSTRAINT fk_stah_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- tests
-- `definition` is the neutral DSL ({ version, name, steps[] }) — it never
-- mentions Playwright. `version` is the test's own revision counter, bumped on
-- every save, with the prior definition kept in service_test_test_versions.
CREATE TABLE service_test_tests (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT              DEFAULT NULL,
  application_id INT          NOT NULL,
  name           VARCHAR(255) NOT NULL,
  description    TEXT             DEFAULT NULL,
  definition     JSON         NOT NULL,
  version        INT          NOT NULL DEFAULT 1,
  credential_id  INT              DEFAULT NULL,
  enabled        TINYINT(1)   NOT NULL DEFAULT 1,
  created_by     INT              DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stt_app (application_id),
  INDEX idx_stt_enabled (enabled),
  CONSTRAINT fk_stt_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_stt_cred FOREIGN KEY (credential_id) REFERENCES service_test_credentials(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Denormalised step rows: the Test Designer's drag & drop order, per-step
-- enable and rename. The `definition` JSON above stays the source of truth for
-- execution; these rows are what the editor reads and reorders.
CREATE TABLE service_test_test_steps (
  id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  test_id    INT          NOT NULL,
  position   INT          NOT NULL,
  step_type  VARCHAR(40)  NOT NULL,
  label      VARCHAR(255)     DEFAULT NULL,
  config     JSON         NOT NULL,
  enabled    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stts_test_pos (test_id, position),
  CONSTRAINT fk_stts_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Prior definitions, one row per saved revision (spec §38 — rollback later).
CREATE TABLE service_test_test_versions (
  id         INT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  test_id    INT      NOT NULL,
  version    INT      NOT NULL,
  definition JSON     NOT NULL,
  created_by INT          DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sttv_test_version (test_id, version),
  CONSTRAINT fk_sttv_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- runs (+ queue)
-- This table IS the job queue. A run is inserted `queued`; the worker claims it
-- with a conditional UPDATE (… SET status='running', claimed_by=? WHERE id=? AND
-- status='queued'), so the claim is atomic and several workers are safe. A run
-- left `running` past the claim timeout is reaped back to `error`.
--
-- `queued` and `error` extend the five statuses in spec §18: without them the
-- queue and "the runner itself broke" have nowhere to live.
CREATE TABLE service_test_runs (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT              DEFAULT NULL,
  test_id        INT          NOT NULL,
  environment_id INT              DEFAULT NULL,
  test_version   INT              DEFAULT NULL,
  status         ENUM('queued','running','pass','fail','warning','skipped','error') NOT NULL DEFAULT 'queued',
  trigger_source ENUM('manual','schedule') NOT NULL DEFAULT 'manual',
  started_at     DATETIME(3)      DEFAULT NULL,
  ended_at       DATETIME(3)      DEFAULT NULL,
  duration_ms    INT              DEFAULT NULL,
  failed_step    INT              DEFAULT NULL,
  error_message  TEXT             DEFAULT NULL,
  failure_kind   VARCHAR(60)      DEFAULT NULL,
  screenshot_path VARCHAR(512)    DEFAULT NULL,
  browser        VARCHAR(40)      DEFAULT NULL,
  console_errors JSON             DEFAULT NULL,
  network_errors JSON             DEFAULT NULL,
  claimed_by     VARCHAR(120)     DEFAULT NULL,
  claimed_at     DATETIME(3)      DEFAULT NULL,
  requested_by   INT              DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_str_test_created (test_id, created_at),
  INDEX idx_str_status (status, created_at),
  CONSTRAINT fk_str_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_str_env FOREIGN KEY (environment_id) REFERENCES service_test_environments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE service_test_run_steps (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id      INT          NOT NULL,
  position    INT          NOT NULL,
  step_type   VARCHAR(40)  NOT NULL,
  label       VARCHAR(255)     DEFAULT NULL,
  status      ENUM('pass','fail','warning','skipped') NOT NULL,
  duration_ms INT              DEFAULT NULL,
  message     TEXT             DEFAULT NULL,
  detail      JSON             DEFAULT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_strs_run_pos (run_id, position),
  CONSTRAINT fk_strs_run FOREIGN KEY (run_id) REFERENCES service_test_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- discovery
CREATE TABLE service_test_discoveries (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT              DEFAULT NULL,
  application_id INT          NOT NULL,
  environment_id INT              DEFAULT NULL,
  status         ENUM('queued','running','complete','failed') NOT NULL DEFAULT 'queued',
  scope_url      VARCHAR(1024) NOT NULL,
  budgets        JSON         NOT NULL,
  page_count     INT          NOT NULL DEFAULT 0,
  form_count     INT          NOT NULL DEFAULT 0,
  element_count  INT          NOT NULL DEFAULT 0,
  request_count  INT          NOT NULL DEFAULT 0,
  login_count    INT          NOT NULL DEFAULT 0,
  error_message  TEXT             DEFAULT NULL,
  started_at     DATETIME(3)      DEFAULT NULL,
  ended_at       DATETIME(3)      DEFAULT NULL,
  claimed_by     VARCHAR(120)     DEFAULT NULL,
  claimed_at     DATETIME(3)      DEFAULT NULL,
  requested_by   INT              DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_std_app_created (application_id, created_at),
  INDEX idx_std_status (status, created_at),
  CONSTRAINT fk_std_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_std_env FOREIGN KEY (environment_id) REFERENCES service_test_environments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE service_test_discovery_pages (
  id           INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  discovery_id INT           NOT NULL,
  url          VARCHAR(1024) NOT NULL,
  title        VARCHAR(512)      DEFAULT NULL,
  http_status  INT               DEFAULT NULL,
  redirected_to VARCHAR(1024)    DEFAULT NULL,
  depth        INT           NOT NULL DEFAULT 0,
  load_ms      INT               DEFAULT NULL,
  console_errors JSON            DEFAULT NULL,
  failed_requests JSON           DEFAULT NULL,
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stdp_disc (discovery_id),
  CONSTRAINT fk_stdp_disc FOREIGN KEY (discovery_id) REFERENCES service_test_discoveries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per interactive element Discovery saw. `possible_login` is deliberately
-- named as a heuristic: Discovery never claims certainty about a login flow
-- (spec §7). `potentially_destructive` marks an element the crawler recorded but
-- refused to activate (spec §8).
CREATE TABLE service_test_discovery_elements (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  discovery_id INT          NOT NULL,
  page_id      INT              DEFAULT NULL,
  kind         ENUM('link','button','input','form','select') NOT NULL,
  label        VARCHAR(512)     DEFAULT NULL,
  attributes   JSON         NOT NULL,
  possible_login TINYINT(1) NOT NULL DEFAULT 0,
  potentially_destructive TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stde_disc_kind (discovery_id, kind),
  CONSTRAINT fk_stde_disc FOREIGN KEY (discovery_id) REFERENCES service_test_discoveries(id) ON DELETE CASCADE,
  CONSTRAINT fk_stde_page FOREIGN KEY (page_id) REFERENCES service_test_discovery_pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- suggestions
-- Rule-based proposals derived from a discovery (spec §12 — NOT AI). Accepting
-- one creates a test; a re-run discovery never overwrites existing tests (§37).
CREATE TABLE service_test_suggestions (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT              DEFAULT NULL,
  discovery_id   INT          NOT NULL,
  application_id INT          NOT NULL,
  name           VARCHAR(255) NOT NULL,
  description    TEXT             DEFAULT NULL,
  confidence     ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  reason         TEXT             DEFAULT NULL,
  proposed_steps JSON         NOT NULL,
  status         ENUM('proposed','accepted','dismissed') NOT NULL DEFAULT 'proposed',
  created_test_id INT             DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sts_disc (discovery_id),
  INDEX idx_sts_app_status (application_id, status),
  CONSTRAINT fk_sts_disc FOREIGN KEY (discovery_id) REFERENCES service_test_discoveries(id) ON DELETE CASCADE,
  CONSTRAINT fk_sts_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_sts_test FOREIGN KEY (created_test_id) REFERENCES service_test_tests(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- schedules
-- interval_sec covers spec §22's fixed choices (60/300/900/3600/86400) without
-- hard-coding them: the UI offers the list, the column stores seconds.
CREATE TABLE service_test_schedules (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT              DEFAULT NULL,
  test_id        INT          NOT NULL,
  environment_id INT              DEFAULT NULL,
  interval_sec   INT          NOT NULL,
  start_at       DATETIME         DEFAULT NULL,
  timezone       VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  enabled        TINYINT(1)   NOT NULL DEFAULT 1,
  last_run_at    DATETIME(3)      DEFAULT NULL,
  created_by     INT              DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stsch_test_env (test_id, environment_id),
  INDEX idx_stsch_enabled (enabled),
  CONSTRAINT fk_stsch_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_stsch_env FOREIGN KEY (environment_id) REFERENCES service_test_environments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
