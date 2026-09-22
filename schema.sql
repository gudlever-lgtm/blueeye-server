-- BlueEyes server — canonical database schema (full snapshot).
--
-- GENERATED FILE — do not edit by hand.
--   Regenerate:  node scripts/build-schema.js
--   Verify:      node scripts/build-schema.js --check   (also run by npm test)
--
-- migrations/ is the source of truth; this file is that chain replayed into one
-- picture of the current schema. It was hand-maintained once and drifted 23
-- tables behind, which is why it is derived now.
--
-- Two ways to set up a database:
--   1) Run the migration runner (recommended):   npm run migrate
--      It applies the ordered files in migrations/ and records them in
--      schema_migrations, so it is safe to re-run.
--   2) Load this snapshot directly into a fresh DB:
--        mysql -u <user> -p <database> < schema.sql
--      Note this leaves schema_migrations EMPTY — a database built this way is
--      already current, so seed it before running the migrator against it.

SET NAMES utf8mb4;

-- Tables are emitted in the order the migrations created them, and that order
-- does NOT satisfy foreign keys: migration 004 can reference a table migration
-- 012 creates, because by then it existed. Loading the snapshot top to bottom
-- therefore hits references to tables that are still to come. Deferring the
-- checks for the length of the load is what mysqldump does for the same reason;
-- they are turned back on at the end, and the constraints themselves are
-- created exactly as written.
SET FOREIGN_KEY_CHECKS = 0;

-- Bookkeeping table used by the migration runner (src/migrate.js).
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  filename VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_schema_migrations_filename (filename)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 001 — create the locations table.
CREATE TABLE IF NOT EXISTS `locations` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT NULL,
  `address` VARCHAR(512) NULL DEFAULT NULL,
  `latitude` DECIMAL(9,6) NULL DEFAULT NULL,
  `longitude` DECIMAL(9,6) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 002 — create the users table (authentication + RBAC).
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email` VARCHAR(255) NOT NULL,
  `name` VARCHAR(120) NULL DEFAULT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `password_changed_at` DATETIME NULL DEFAULT NULL,
  `role` ENUM('admin', 'operator', 'viewer') NOT NULL DEFAULT 'viewer',
  `protected` TINYINT(1) NOT NULL DEFAULT 0,
  `preferences` JSON DEFAULT NULL,
  `last_seen_changes` DATETIME NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `tokens_valid_after` DATETIME NULL DEFAULT NULL,
  `must_change_password` TINYINT(1) NOT NULL DEFAULT 0,
  `temp_password_expires_at` DATETIME NULL DEFAULT NULL,
  `temp_password_created_by` INT UNSIGNED NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT fk_users_temp_pw_creator FOREIGN KEY (temp_password_created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 003 — create the agents table.
CREATE TABLE IF NOT EXISTS `agents` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `hostname` VARCHAR(255) NOT NULL,
  `platform` VARCHAR(64) NOT NULL,
  `arch` VARCHAR(32) NOT NULL,
  `last_seen` DATETIME NULL DEFAULT NULL,
  `status` ENUM('online', 'offline') NOT NULL DEFAULT 'offline',
  `capabilities` JSON NULL DEFAULT NULL,
  `location_id` INT UNSIGNED NULL DEFAULT NULL,
  `enrollment_code_id` INT UNSIGNED NULL DEFAULT NULL,
  `display_name` VARCHAR(255) NULL DEFAULT NULL,
  `notes` TEXT NULL DEFAULT NULL,
  `meta` JSON NULL DEFAULT NULL,
  `monitor_config` JSON NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_agents_location_id (location_id),
  CONSTRAINT fk_agents_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL,
  KEY idx_agents_enrollment_code_id (enrollment_code_id),
  CONSTRAINT fk_agents_enrollment_code FOREIGN KEY (enrollment_code_id) REFERENCES enrollment_codes (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One-time codes used to enroll new agents. The `code` is random and unique;
-- it is returned to the operator once at creation.
CREATE TABLE IF NOT EXISTS `enrollment_codes` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `location_id` INT UNSIGNED NULL DEFAULT NULL,
  `created_by` INT UNSIGNED NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `max_uses` INT UNSIGNED NOT NULL DEFAULT 1,
  `uses_remaining` INT UNSIGNED NOT NULL DEFAULT 1,
  `used_at` DATETIME NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `code_hash` CHAR(64) NULL DEFAULT NULL,
  `code_enc` TEXT NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_enrollment_codes_location_id (location_id),
  KEY idx_enrollment_codes_created_by (created_by),
  CONSTRAINT fk_enrollment_codes_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL,
  CONSTRAINT fk_enrollment_codes_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE,
  UNIQUE KEY uq_enrollment_codes_code_hash (code_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Opaque agent tokens. Only the SHA-256 hash is stored, never the token itself.
CREATE TABLE IF NOT EXISTS `agent_tokens` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NULL DEFAULT NULL,
  `token_hash` VARCHAR(64) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` DATETIME NULL DEFAULT NULL,
  `revoked_at` DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_tokens_token_hash (token_hash),
  KEY idx_agent_tokens_agent_id (agent_id),
  CONSTRAINT fk_agent_tokens_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 005 — test results reported by agents.
CREATE TABLE IF NOT EXISTS `results` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `payload` JSON NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_results_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
  KEY idx_results_agent_created (agent_id, created_at),
  KEY idx_results_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 009 — analysis findings. Each row is a detected condition; explanation and
-- evidence are mandatory (enforced in the FindingStore before insert).
CREATE TABLE IF NOT EXISTS `findings` (
  `id` CHAR(36) NOT NULL,
  `host_id` VARCHAR(255) NOT NULL,
  `device_id` INT UNSIGNED NULL DEFAULT NULL,
  `interface_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `metric` VARCHAR(255) NOT NULL,
  `severity` ENUM('INFO', 'WARN', 'CRIT') NOT NULL,
  `original_severity` ENUM('INFO','WARN','CRIT') DEFAULT NULL,
  `severity_rule_id` INT DEFAULT NULL,
  `kind` ENUM('ANOMALY', 'THRESHOLD', 'FLATLINE', 'CORRELATED') NOT NULL,
  `observed` DOUBLE NULL DEFAULT NULL,
  `baseline` DOUBLE NULL DEFAULT NULL,
  `deviation` DOUBLE NULL DEFAULT NULL,
  `window_from` DATETIME NULL DEFAULT NULL,
  `window_to` DATETIME NULL DEFAULT NULL,
  `explanation` TEXT NOT NULL,
  `evidence` JSON NOT NULL,
  `correlated_with` JSON NULL DEFAULT NULL,
  `event_case_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `acked` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_findings_host_created (host_id, created_at),
  KEY idx_findings_created (created_at),
  KEY idx_findings_event_case (event_case_id),
  CONSTRAINT fk_findings_event_case FOREIGN KEY (event_case_id) REFERENCES event_cases (id) ON DELETE SET NULL,
  CONSTRAINT fk_findings_severity_rule FOREIGN KEY (severity_rule_id) REFERENCES event_severity_rules(id) ON DELETE SET NULL,
  KEY idx_findings_device_created (`device_id`, `created_at`),
  KEY idx_findings_interface_created (`interface_id`, `created_at`),
  KEY idx_findings_open (`acked`, `host_id`, `metric`, `severity`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 010 — geo-enriched flow records. One row per reported flow. The external
-- (public) peer is geolocated to country + ASN; purely-internal flows (RFC1918
-- on both ends) are stored with internal=1 and are never geolocated.
CREATE TABLE IF NOT EXISTS `flow_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `ts` DATETIME NOT NULL,
  `src_ip` VARCHAR(45) NULL DEFAULT NULL,
  `dst_ip` VARCHAR(45) NULL DEFAULT NULL,
  `ext_ip` VARCHAR(45) NULL DEFAULT NULL,
  `direction` ENUM('in', 'out') NULL DEFAULT NULL,
  `proto` VARCHAR(16) NULL DEFAULT NULL,
  `src_port` INT NULL DEFAULT NULL,
  `dst_port` INT NULL DEFAULT NULL,
  `bytes` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `packets` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `flows` INT UNSIGNED NOT NULL DEFAULT 0,
  `internal` TINYINT(1) NOT NULL DEFAULT 0,
  `country` CHAR(2) NULL DEFAULT NULL,
  `asn` INT UNSIGNED NULL DEFAULT NULL,
  `asn_name` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_flows_agent_ts (agent_id, ts),
  KEY idx_flows_country_ts (country, ts),
  KEY idx_flows_asn_ts (asn, ts),
  KEY idx_flows_ts (ts),
  CONSTRAINT fk_flows_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 011 — down-sampled flow records. Raw flow_records older than the raw-retention
-- window are aggregated into time buckets per (agent, direction, peer country,
-- peer ASN). Only external (geolocated) flows are rolled up. The unique key lets
-- a re-run merge instead of duplicating (idempotent rollup).
CREATE TABLE IF NOT EXISTS `flow_rollup` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `bucket` DATETIME NOT NULL,
  `agent_id` INT UNSIGNED NOT NULL,
  `direction` ENUM('in', 'out') NOT NULL DEFAULT 'out',
  `country` CHAR(2) NOT NULL DEFAULT '',
  `asn` INT UNSIGNED NOT NULL DEFAULT 0,
  `asn_name` VARCHAR(255) NULL DEFAULT NULL,
  `bytes` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `packets` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `flow_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `bytes_min` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `bytes_max` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `bytes_median` DOUBLE NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_flow_rollup_bucket (agent_id, bucket, direction, country, asn),
  KEY idx_flow_rollup_bucket (bucket),
  KEY idx_flow_rollup_country (country, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 012 — down-sampled metric time-series. Raw metric samples (extracted from
-- result payloads) older than the raw-retention window are aggregated into time
-- buckets per (agent, metric), keeping min/max/median and a sample count. The
-- unique key makes re-runs idempotent (merge instead of duplicate).
CREATE TABLE IF NOT EXISTS `metric_rollup` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `bucket` DATETIME NOT NULL,
  `agent_id` INT UNSIGNED NOT NULL,
  `metric` VARCHAR(64) NOT NULL,
  `samples` INT UNSIGNED NOT NULL DEFAULT 0,
  `val_min` DOUBLE NOT NULL DEFAULT 0,
  `val_max` DOUBLE NOT NULL DEFAULT 0,
  `val_median` DOUBLE NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_metric_rollup_bucket (agent_id, metric, bucket),
  KEY idx_metric_rollup_bucket (bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 013 — small key/value store for runtime-editable settings (e.g. map tiles).
-- Most configuration stays in env; this table holds the few values an admin can
-- change from the dashboard without a restart. Values are JSON.
CREATE TABLE IF NOT EXISTS `app_settings` (
  `setting_key` VARCHAR(64) NOT NULL,
  `value` JSON NOT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 014 — active-probe results. The agent runs ping / TCP-connect / DNS /
-- traceroute probes (on operator command) and reports them here, giving
-- reachability + latency/loss/jitter over time for troubleshooting. Metadata
-- only: targets and timings, never payload.
CREATE TABLE IF NOT EXISTS `probe_results` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `ts` DATETIME NOT NULL,
  `type` VARCHAR(16) NOT NULL,
  `target` VARCHAR(255) NOT NULL,
  `ok` TINYINT(1) NOT NULL DEFAULT 0,
  `rtt_ms` DOUBLE NULL DEFAULT NULL,
  `min_ms` DOUBLE NULL DEFAULT NULL,
  `max_ms` DOUBLE NULL DEFAULT NULL,
  `jitter_ms` DOUBLE NULL DEFAULT NULL,
  `loss_pct` DOUBLE NULL DEFAULT NULL,
  `status` SMALLINT NULL DEFAULT NULL,
  `cert_expiry_days` INT NULL DEFAULT NULL,
  `bytes` BIGINT NULL DEFAULT NULL,
  `content_type` VARCHAR(120) NULL DEFAULT NULL,
  `elements` JSON NULL DEFAULT NULL,
  `hops` JSON NULL DEFAULT NULL,
  `mtu` JSON NULL DEFAULT NULL,
  `sizes` JSON NULL DEFAULT NULL,
  `tls` JSON NULL DEFAULT NULL,
  `rdns` JSON NULL DEFAULT NULL,
  `detail` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_probe_agent_ts (agent_id, ts),
  KEY idx_probe_agent_type_ts (agent_id, type, ts),
  CONSTRAINT fk_probe_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
  KEY idx_probe_ts (ts),
  KEY idx_probe_agent_type_target_id (agent_id, type, target, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 017 — server-defined "test packages": a named set of probe/traffic tests the
-- server pushes to selected agents (all / specific / by location) to run, on a
-- schedule or on demand. Agents execute via the existing run-probe / run-test
-- commands and report results through the normal endpoints. Metadata only:
-- targets and timings, never payload.
CREATE TABLE IF NOT EXISTS `test_packages` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `schedule_ms` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `schedule_spec` JSON NULL DEFAULT NULL,
  `targets` JSON NOT NULL,
  `items` JSON NOT NULL,
  `created_by` VARCHAR(255) NULL DEFAULT NULL,
  `last_run_at` DATETIME NULL DEFAULT NULL,
  `last_run_summary` JSON NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_test_packages_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 018 — active throughput ("speed test") results. The agent downloads then
-- uploads a sized blob to/from this server and reports the achieved rate in
-- Mbps. Self-contained (no external speed-test service). Metadata only: byte
-- counts and timings, never payload.
CREATE TABLE IF NOT EXISTS `speedtest_results` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `ts` DATETIME NOT NULL,
  `ok` TINYINT(1) NOT NULL DEFAULT 0,
  `down_mbps` DOUBLE NULL DEFAULT NULL,
  `up_mbps` DOUBLE NULL DEFAULT NULL,
  `down_bytes` BIGINT UNSIGNED NULL DEFAULT NULL,
  `up_bytes` BIGINT UNSIGNED NULL DEFAULT NULL,
  `down_ms` DOUBLE NULL DEFAULT NULL,
  `up_ms` DOUBLE NULL DEFAULT NULL,
  `target` VARCHAR(255) NULL DEFAULT NULL,
  `detail` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_speedtest_agent_ts (agent_id, ts),
  CONSTRAINT fk_speedtest_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 022 — persistent audit trail for server-initiated agent actions (upgrade /
-- delete). One row per action, carrying TWO states on the SAME record:
-- 'requested' when the server sent the command, then 'completed'/'failed' when
-- the agent reports back (with completed_at + result_detail). Agent identity is
-- SNAPSHOTTED (hostname/location) so the trail survives the agent being deleted
-- (agent_id then FK-nulls but the row remains). Searchable per agent and per
-- actor. Holds NO secrets — tokens/signatures are never written here.
CREATE TABLE IF NOT EXISTS `agent_action_audit` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NULL DEFAULT NULL,
  `agent_hostname` VARCHAR(255) NULL DEFAULT NULL,
  `location_id` INT UNSIGNED NULL DEFAULT NULL,
  `actor_user_id` INT UNSIGNED NULL DEFAULT NULL,
  `actor_email` VARCHAR(255) NULL DEFAULT NULL,
  `actor_role` VARCHAR(32) NULL DEFAULT NULL,
  `action` ENUM('upgrade', 'delete', 'install-tool', 'rekey') NOT NULL,
  `target_version` VARCHAR(64) NULL DEFAULT NULL,
  `state` ENUM('requested', 'completed', 'failed') NOT NULL DEFAULT 'requested',
  `result_detail` VARCHAR(512) NULL DEFAULT NULL,
  `requested_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at` DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_audit_agent (agent_id, requested_at),
  KEY idx_audit_actor (actor_user_id, requested_at),
  CONSTRAINT fk_audit_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The sellable packages. `allowed_features` is a JSON array of feature keys;
-- NULL max_* means unlimited / configurable (Enterprise & MSP).
CREATE TABLE IF NOT EXISTS `license_plans` (
  `plan_key` VARCHAR(32) NOT NULL,
  `plan_name` VARCHAR(64) NOT NULL,
  `max_agents` INT UNSIGNED NULL DEFAULT NULL,
  `max_test_paths` INT UNSIGNED NULL DEFAULT NULL,
  `history_days` INT UNSIGNED NULL DEFAULT NULL,
  `allowed_features` JSON NULL,
  `support_level` VARCHAR(32) NOT NULL DEFAULT 'basic',
  `is_trial` TINYINT(1) NOT NULL DEFAULT 0,
  `trial_days` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_msp` TINYINT(1) NOT NULL DEFAULT 0,
  `is_enterprise` TINYINT(1) NOT NULL DEFAULT 0,
  `price_reference_eur` INT UNSIGNED NULL DEFAULT NULL,
  `price_reference_dkk` INT UNSIGNED NULL DEFAULT NULL,
  `price_from` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (plan_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The locally-stored license(s). For the current online-validation model these
-- mirror the signed proof; for the future offline model the signed_payload +
-- signature are the proof itself (verified by src/license/verify.js). The
-- *_override columns let a specific customer license raise/lower a plan default
-- without editing the plan. organization_id is reserved for the MSP model.
CREATE TABLE IF NOT EXISTS `licenses` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `organization_id` INT UNSIGNED NULL DEFAULT NULL,
  `plan_key` VARCHAR(32) NOT NULL,
  `license_key` VARCHAR(128) NULL DEFAULT NULL,
  `license_status` ENUM('active', 'trial', 'grace', 'expired', 'revoked', 'unlicensed')
    NOT NULL DEFAULT 'unlicensed',
  `valid_from` DATETIME NULL DEFAULT NULL,
  `valid_until` DATETIME NULL DEFAULT NULL,
  `max_agents_override` INT UNSIGNED NULL DEFAULT NULL,
  `max_test_paths_override` INT UNSIGNED NULL DEFAULT NULL,
  `history_days_override` INT UNSIGNED NULL DEFAULT NULL,
  `support_level_override` VARCHAR(32) NULL DEFAULT NULL,
  `is_trial` TINYINT(1) NOT NULL DEFAULT 0,
  `signed_payload` JSON NULL,
  `signature` VARCHAR(512) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_license_status (license_status),
  CONSTRAINT fk_license_plan FOREIGN KEY (plan_key) REFERENCES license_plans (plan_key) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 026 — outbound API integrations (ITSM/IPAM connectors). One row per configured
-- target system: ServiceNow (incidents), Nautobot (device/site sync), a generic
-- webhook, and future connectors. Credentials are ENCRYPTED at rest (AES-256-GCM
-- via src/lib/secretBox.js) in credentials_encrypted — NEVER plaintext, and never
-- returned by the API. config_json holds non-secret, connector-specific settings
-- (which events to fire on, the ServiceNow table, the Nautobot allow-delete flag).
CREATE TABLE IF NOT EXISTS `integrations` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `type` VARCHAR(32) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `base_url` VARCHAR(512) NOT NULL,
  `auth_type` VARCHAR(32) NOT NULL DEFAULT 'none',
  `credentials_encrypted` TEXT NULL DEFAULT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `config_json` JSON NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_integrations_name (name),
  KEY idx_integrations_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 027 — audit trail for outbound integration calls. One row per fire (an event
-- trigger or a manual test), capturing the outcome (ok/fail), the target's HTTP
-- status code, the number of attempts (retry/backoff), and WHO triggered a manual
-- test (system-triggered events have no actor). The integration name + type are
-- SNAPSHOTTED so the trail survives the integration being deleted (the FK then
-- nulls but the row remains). Holds NO secrets — credentials/tokens are never
-- written here.
CREATE TABLE IF NOT EXISTS `integration_audit` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `integration_id` INT UNSIGNED NULL DEFAULT NULL,
  `integration_name` VARCHAR(255) NULL DEFAULT NULL,
  `integration_type` VARCHAR(32) NULL DEFAULT NULL,
  `event` VARCHAR(64) NOT NULL,
  `correlation_id` VARCHAR(255) NULL DEFAULT NULL,
  `ok` TINYINT(1) NOT NULL DEFAULT 0,
  `status_code` INT NULL DEFAULT NULL,
  `attempts` INT UNSIGNED NOT NULL DEFAULT 1,
  `detail` VARCHAR(512) NULL DEFAULT NULL,
  `actor_user_id` INT UNSIGNED NULL DEFAULT NULL,
  `actor_email` VARCHAR(255) NULL DEFAULT NULL,
  `actor_role` VARCHAR(32) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_integration_audit_integration (integration_id, created_at),
  KEY idx_integration_audit_event (event, created_at),
  CONSTRAINT fk_integration_audit_integration FOREIGN KEY (integration_id) REFERENCES integrations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 028 — external auth via LDAP/AD (supplements local JWT login). A single-row
-- connection config (ldap_config) + a group-to-role map (ldap_role_map). The same
-- code path serves Microsoft AD and OpenLDAP; the difference is just the filters.
-- The bind password is ENCRYPTED at rest (AES-256-GCM via src/lib/secretBox.js) in
-- bind_pw_encrypted — never plaintext, never returned by the API. LDAP login is
-- gated behind LDAP_AUTH_ENABLED (default false) AND ldap_config.enabled.
CREATE TABLE IF NOT EXISTS `ldap_config` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `host` VARCHAR(255) NOT NULL,
  `port` INT UNSIGNED NOT NULL DEFAULT 389,
  `use_tls` TINYINT(1) NOT NULL DEFAULT 1,
  `bind_dn` VARCHAR(512) NULL DEFAULT NULL,
  `bind_pw_encrypted` TEXT NULL DEFAULT NULL,
  `base_dn` VARCHAR(512) NOT NULL,
  `user_filter` VARCHAR(512) NOT NULL DEFAULT '(sAMAccountName={{username}})',
  `group_filter` VARCHAR(512) NULL DEFAULT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Maps an LDAP/AD group DN to a BlueEyes role. On login the user's groups are
-- looked up and the HIGHEST matching role wins (admin > operator > viewer). NO
-- match means access is DENIED — there is deliberately no default role.
CREATE TABLE IF NOT EXISTS `ldap_role_map` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ldap_group_dn` VARCHAR(512) NOT NULL,
  `blueeye_role` ENUM('admin', 'operator', 'viewer') NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ldap_role_map_group (ldap_group_dn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 029 — audit trail for LDAP/AD login attempts (success + failure). Records the
-- username, the outcome + reason, how many groups matched a role, the granted
-- role, and the source IP. Holds NO secrets — passwords are never written here.
-- Local JWT logins are unchanged; this only covers the external-auth path.
CREATE TABLE IF NOT EXISTS `ldap_login_audit` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(255) NULL DEFAULT NULL,
  `ok` TINYINT(1) NOT NULL DEFAULT 0,
  `reason` VARCHAR(64) NULL DEFAULT NULL,
  `granted_role` VARCHAR(32) NULL DEFAULT NULL,
  `groups_matched` INT UNSIGNED NOT NULL DEFAULT 0,
  `source_ip` VARCHAR(64) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ldap_login_audit_user (username, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 030 — the agent-release signing key, generated + managed from the dashboard
-- (Settings → Agent signing key). A single Ed25519 key pair created ON the server:
-- the PRIVATE key is stored ENCRYPTED at rest (AES-256-GCM via src/lib/secretBox.js)
-- in private_pem_encrypted and is NEVER returned by the API — it is decrypted only
-- in memory to sign agent releases. The PUBLIC key (not secret) is served to agents
-- so they can verify signed self-updates. Write-once + deletable: at most one row
-- (the UNIQUE singleton column is the backstop). Without a key the server can
-- neither onboard new agents nor sign upgrades.
CREATE TABLE IF NOT EXISTS `agent_release_key` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `singleton` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `public_pem` TEXT NOT NULL,
  `private_pem_encrypted` TEXT NOT NULL,
  `fingerprint` CHAR(64) NOT NULL,
  `created_by` INT UNSIGNED NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_release_key_singleton (singleton)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Risk register. risk_score is stored (likelihood * impact, both 1..5) so the API
-- never has to recompute it for filtering/sorting; the route guarantees it stays
-- consistent. management_acceptance records a documented risk-acceptance decision.
CREATE TABLE IF NOT EXISTS `blueeye_nis2_risks` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT NULL DEFAULT NULL,
  `category` VARCHAR(64) NOT NULL,
  `affected_asset` VARCHAR(255) NULL DEFAULT NULL,
  `likelihood` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `impact` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `risk_score` SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `owner` VARCHAR(255) NULL DEFAULT NULL,
  `status` ENUM('open', 'mitigating', 'accepted', 'closed') NOT NULL DEFAULT 'open',
  `mitigation_plan` TEXT NULL DEFAULT NULL,
  `due_date` DATE NULL DEFAULT NULL,
  `management_acceptance` TINYINT(1) NOT NULL DEFAULT 0,
  `evidence_link` VARCHAR(1024) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_nis2_risks_status (status),
  KEY idx_nis2_risks_category (category),
  KEY idx_nis2_risks_score (risk_score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Control evidence. A control is a recurring assurance activity tied to a NIS2
-- area. status reflects evidence health (OK / Partial / Missing / Overdue);
-- next_due drives the "overdue" highlighting on the dashboard.
CREATE TABLE IF NOT EXISTS `blueeye_nis2_controls` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `control_name` VARCHAR(255) NOT NULL,
  `nis2_area` VARCHAR(64) NOT NULL,
  `description` TEXT NULL DEFAULT NULL,
  `owner` VARCHAR(255) NULL DEFAULT NULL,
  `frequency` ENUM('daily', 'weekly', 'monthly', 'quarterly', 'annually', 'ad-hoc') NOT NULL DEFAULT 'quarterly',
  `last_performed` DATE NULL DEFAULT NULL,
  `next_due` DATE NULL DEFAULT NULL,
  `evidence_file` VARCHAR(1024) NULL DEFAULT NULL,
  `status` ENUM('OK', 'Partial', 'Missing', 'Overdue') NOT NULL DEFAULT 'Missing',
  `comment` TEXT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_nis2_controls_area (nis2_area),
  KEY idx_nis2_controls_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Security incidents (NIS2 sense — distinct from the network `incidents` table,
-- which is derived from probes). incident_id is a human reference (INC-YYYY-NNNN)
-- generated by the repository. nis2_relevant / notification_required flag the
-- subset that may trigger a regulator notification obligation.
CREATE TABLE IF NOT EXISTS `blueeye_nis2_incidents` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `incident_id` VARCHAR(32) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `severity` ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'medium',
  `detected_at` DATETIME NULL DEFAULT NULL,
  `started_at` DATETIME NULL DEFAULT NULL,
  `resolved_at` DATETIME NULL DEFAULT NULL,
  `affected_systems` TEXT NULL DEFAULT NULL,
  `business_impact` TEXT NULL DEFAULT NULL,
  `root_cause` TEXT NULL DEFAULT NULL,
  `actions_taken` TEXT NULL DEFAULT NULL,
  `nis2_relevant` TINYINT(1) NOT NULL DEFAULT 0,
  `notification_required` TINYINT(1) NOT NULL DEFAULT 0,
  `status` ENUM('open', 'investigating', 'contained', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  `lessons_learned` TEXT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_nis2_incident_ref (incident_id),
  KEY idx_nis2_incidents_severity (severity),
  KEY idx_nis2_incidents_status (status),
  KEY idx_nis2_incidents_detected (detected_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Generated reports. snapshot_json freezes the headline metrics at generation
-- time so the NEXT report can show the delta ("development since last report").
-- A report is a draft until an admin/compliance approver accepts it.
CREATE TABLE IF NOT EXISTS `blueeye_nis2_reports` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `report_type` ENUM('readiness', 'executive', 'risk', 'control', 'incident') NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `period_start` DATE NULL DEFAULT NULL,
  `period_end` DATE NULL DEFAULT NULL,
  `status` ENUM('draft', 'approved') NOT NULL DEFAULT 'draft',
  `summary` TEXT NULL DEFAULT NULL,
  `snapshot_json` JSON NULL DEFAULT NULL,
  `generated_by` INT UNSIGNED NULL DEFAULT NULL,
  `generated_by_email` VARCHAR(255) NULL DEFAULT NULL,
  `approved_by` INT UNSIGNED NULL DEFAULT NULL,
  `approved_by_email` VARCHAR(255) NULL DEFAULT NULL,
  `approved_at` DATETIME NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_nis2_reports_type (report_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Evidence references. A piece of evidence (document/link/screenshot) optionally
-- attached to a control, risk or report. Stored as a reference (file_url) rather
-- than a binary blob so the module needs no object store; the upload route
-- validates + sanitises the reference. Polymorphic link (entity_type/entity_id),
-- so it carries no FK.
CREATE TABLE IF NOT EXISTS `blueeye_nis2_evidence` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT NULL DEFAULT NULL,
  `file_name` VARCHAR(255) NULL DEFAULT NULL,
  `file_url` VARCHAR(1024) NULL DEFAULT NULL,
  `content_type` VARCHAR(128) NULL DEFAULT NULL,
  `entity_type` ENUM('control', 'risk', 'incident', 'report') NULL DEFAULT NULL,
  `entity_id` INT UNSIGNED NULL DEFAULT NULL,
  `uploaded_by` INT UNSIGNED NULL DEFAULT NULL,
  `uploaded_by_email` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_nis2_evidence_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Generic audit log for the NIS2 module. One row per create/update/delete of a
-- risk, control or incident. old_value/new_value hold JSON snapshots so a change
-- is fully reconstructable. Actor identity is snapshotted (email) so the trail
-- survives user changes. No FK to users for the same reason.
CREATE TABLE IF NOT EXISTS `blueeye_audit_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NULL DEFAULT NULL,
  `user_email` VARCHAR(255) NULL DEFAULT NULL,
  `action` VARCHAR(32) NOT NULL,
  `entity_type` VARCHAR(32) NOT NULL,
  `entity_id` INT UNSIGNED NULL DEFAULT NULL,
  `old_value` JSON NULL DEFAULT NULL,
  `new_value` JSON NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_log_entity (entity_type, entity_id),
  KEY idx_audit_log_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 033 — unified audit log (license feature `audit_log`, Professional+).
--
-- A general security/change trail that complements the existing, purpose-built
-- trails (agent_action_audit for upgrade/delete, blueeye_audit_log for the NIS2
-- module, ldap_login_audit for LDAP binds). This table records *who did what*
-- across authentication, user/role administration, licence actions, report
-- generation and API-token management.
--
-- Privacy by design: metadata only. NEVER store passwords, tokens, secrets or
-- request payloads — only the actor, the action, the affected target and a short
-- human detail string. `detail` is plain text kept well under the column width.
CREATE TABLE IF NOT EXISTS `audit_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `category` VARCHAR(32) NOT NULL,
  `action` VARCHAR(64) NOT NULL,
  `outcome` ENUM('success', 'failure', 'denied') NOT NULL DEFAULT 'success',
  `actor_user_id` INT UNSIGNED NULL DEFAULT NULL,
  `actor_email` VARCHAR(255) NULL DEFAULT NULL,
  `actor_role` VARCHAR(32) NULL DEFAULT NULL,
  `target` VARCHAR(255) NULL DEFAULT NULL,
  `detail` VARCHAR(512) NULL DEFAULT NULL,
  `ip` VARCHAR(64) NULL DEFAULT NULL,
  `prev_hash` CHAR(64) NULL DEFAULT NULL,
  `entry_hash` CHAR(64) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_audit_log_created (created_at),
  KEY idx_audit_log_category (category, created_at),
  KEY idx_audit_log_actor (actor_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 034 — API tokens for programmatic access (license feature `api_access`,
-- Professional+). A token authenticates REST calls without an interactive login
-- and acts with a fixed role (viewer/operator/admin).
--
-- Only the SHA-256 HASH of the token is stored (token_hash) — the plaintext is
-- shown to the operator once at creation and is unrecoverable thereafter, the
-- same posture as agent tokens and encrypted secrets elsewhere. token_prefix is
-- a short, non-secret fragment kept only so the UI can identify a token in a list.
CREATE TABLE IF NOT EXISTS `api_tokens` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `token_prefix` VARCHAR(32) NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `role` ENUM('admin', 'operator', 'viewer') NOT NULL DEFAULT 'viewer',
  `created_by_user_id` INT UNSIGNED NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` TIMESTAMP NULL DEFAULT NULL,
  `expires_at` TIMESTAMP NULL DEFAULT NULL,
  `revoked_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_tokens_hash (token_hash),
  KEY idx_api_tokens_active (revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 035 — unified, server-wide audit trail surfaced under Reporting → Audit.
-- Captures WHO (actor), WHEN (ts) and WHAT (action + target) for two kinds of
-- activity:
--   * user actions on the server — every successful state-changing request
--     (login + POST/PUT/PATCH/DELETE), recorded by the audit middleware;
--   * agent activity — what each agent actually performed (traffic measurements,
--     probes), recorded on ingest.
--
-- Repeated/recurring activity (continuous traffic reporting, scheduled probes)
-- is NOT one row per occurrence: the FIRST run is audited and every repeat is
-- folded onto that same row (occurrences++, last_seen_at bumped) via a nullable
-- UNIQUE dedup_key + INSERT ... ON DUPLICATE KEY UPDATE. Discrete user actions
-- leave dedup_key NULL (many NULLs are allowed in a MySQL unique index), so each
-- one is its own row. Holds NO secrets — bodies are redacted before they land in
-- `detail`.
CREATE TABLE IF NOT EXISTS `audit_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ts` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actor_type` VARCHAR(16) NOT NULL,
  `actor_id` INT UNSIGNED NULL DEFAULT NULL,
  `actor_label` VARCHAR(255) NULL DEFAULT NULL,
  `actor_role` VARCHAR(32) NULL DEFAULT NULL,
  `action` VARCHAR(96) NOT NULL,
  `target_type` VARCHAR(64) NULL DEFAULT NULL,
  `target_id` VARCHAR(64) NULL DEFAULT NULL,
  `target_label` VARCHAR(255) NULL DEFAULT NULL,
  `method` VARCHAR(8) NULL DEFAULT NULL,
  `path` VARCHAR(255) NULL DEFAULT NULL,
  `status` INT NULL DEFAULT NULL,
  `ip` VARCHAR(64) NULL DEFAULT NULL,
  `detail` JSON NULL DEFAULT NULL,
  `repeat_interval_ms` INT UNSIGNED NULL DEFAULT NULL,
  `occurrences` INT UNSIGNED NOT NULL DEFAULT 1,
  `first_seen_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `dedup_key` VARCHAR(255) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_dedup (dedup_key),
  KEY idx_audit_ts (ts),
  KEY idx_audit_actor (actor_type, actor_id),
  KEY idx_audit_action (action),
  KEY idx_audit_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Maps an OIDC claim value (a group/role name from the id-token `groups` claim,
-- configurable via OIDC_ROLE_CLAIM) to a BlueEyes role. On login the user's claim
-- values are looked up and the HIGHEST matching role wins (admin > operator >
-- viewer). NO match means access is DENIED — there is deliberately no default role.
CREATE TABLE IF NOT EXISTS `oidc_role_map` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `claim_value` VARCHAR(512) NOT NULL,
  `blueeye_role` ENUM('admin', 'operator', 'viewer') NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_oidc_role_map_claim (claim_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit trail for federated (OIDC/SAML) login attempts (success + failure).
-- Shared by both SSO flows; `provider` distinguishes them. Records the subject
-- (id-token sub / SAML NameID), the outcome + reason, how many groups matched a
-- role, the granted role and the source IP. Holds NO secrets — tokens and
-- assertions are never written here. Local + LDAP logins are unaffected.
CREATE TABLE IF NOT EXISTS `sso_login_audit` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider` VARCHAR(16) NOT NULL DEFAULT 'oidc',
  `subject` VARCHAR(255) NULL DEFAULT NULL,
  `ok` TINYINT(1) NOT NULL DEFAULT 0,
  `reason` VARCHAR(64) NULL DEFAULT NULL,
  `granted_role` VARCHAR(32) NULL DEFAULT NULL,
  `groups_matched` INT UNSIGNED NOT NULL DEFAULT 0,
  `source_ip` VARCHAR(64) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sso_login_audit_provider (provider, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Maps a SAML attribute value (a group/role name from the configured role
-- attribute, default `groups`) to a BlueEyes role. On login the user's attribute
-- values are looked up and the HIGHEST matching role wins (admin > operator >
-- viewer). NO match means access is DENIED — there is deliberately no default
-- role. The column is named `claim_value` to share the generic role-map surface
-- with OIDC (oidc_role_map).
CREATE TABLE IF NOT EXISTS `saml_role_map` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `claim_value` VARCHAR(512) NOT NULL,
  `blueeye_role` ENUM('admin', 'operator', 'viewer') NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_saml_role_map_claim (claim_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- 1. Password history + age ------------------------------------------------
-- Past password hashes, newest-first by id, so a change can refuse to reuse the
-- last N. Hashes only (bcrypt) — never plaintext. Dropped with the user.
CREATE TABLE IF NOT EXISTS `password_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_password_history_user (user_id, id),
  CONSTRAINT fk_password_history_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lokationsdrevet investigation-resultater. Gemmer output fra
-- runInvestigation() inkl. klassifikation, beviser og eventuel AI-narrativ.
CREATE TABLE IF NOT EXISTS `investigations` (
  `id` CHAR(36)      NOT NULL,
  `location_ref` JSON          NOT NULL,
  `window_from` DATETIME      NOT NULL,
  `window_to` DATETIME      NOT NULL,
  `classification` ENUM('LOCAL','UPSTREAM','DOWNSTREAM','APP_NOT_NET','INSUFFICIENT_DATA') NOT NULL,
  `confidence` DECIMAL(4,3)  NOT NULL DEFAULT 0,
  `explanation` TEXT          NOT NULL,
  `evidence` JSON          NOT NULL,
  `suspected_segment` JSON        NULL,
  `related_finding_ids` JSON      NOT NULL DEFAULT ('[]'),
  `workaround_hints` JSON      NOT NULL DEFAULT ('[]'),
  `narrative` TEXT          NULL,
  `created_at` TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_investigations_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `transaction_tests` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `type` ENUM('http','tcp','dns','icmp') NOT NULL,
  `target` VARCHAR(255)     DEFAULT NULL,
  `config` JSON         NOT NULL,
  `config_secrets` JSON             DEFAULT NULL,
  `interval_sec` INT          NOT NULL DEFAULT 60,
  `enabled` TINYINT(1)   NOT NULL DEFAULT 1,
  `created_by` INT              DEFAULT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Assignment join. PK on (test_id, agent_id). No FKs (kept lean; the app deletes
-- assignments explicitly on test/agent removal).
CREATE TABLE IF NOT EXISTS `transaction_test_agents` (
  `test_id` INT NOT NULL,
  `agent_id` INT NOT NULL,
  PRIMARY KEY (test_id, agent_id),
  INDEX idx_txa_agent (agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One result per (agent, test, run). step_timings carries per-step ms; detail is
-- structured JSON-in-string {phase,step,errno} for failures. NO foreign keys —
-- this table is destined for TimescaleDB.
CREATE TABLE IF NOT EXISTS `transaction_results` (
  `time` DATETIME(3) NOT NULL,
  `test_id` INT         NOT NULL,
  `agent_id` INT         NOT NULL,
  `status` ENUM('ok','fail','timeout','error') NOT NULL,
  `latency_ms` INT             DEFAULT NULL,
  `step_timings` JSON           DEFAULT NULL,
  `step_failed` TINYINT         DEFAULT NULL,
  `deviation` ENUM('normal','slower','faster') DEFAULT NULL,
  `detail` VARCHAR(255)    DEFAULT NULL,
  INDEX idx_txr_test_agent_time (test_id, agent_id, time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Robust baseline per (test, agent, step): median + MAD over the last 7 days of
-- ok results, recomputed hourly by the baseline job. step 0 = whole-test latency;
-- steps 1..N = per-step timings (http). PK on (test, agent, step).
CREATE TABLE IF NOT EXISTS `transaction_baselines` (
  `test_id` INT     NOT NULL,
  `agent_id` INT     NOT NULL,
  `step` TINYINT NOT NULL,
  `median_ms` INT     NOT NULL,
  `mad_ms` INT     NOT NULL,
  `sample_count` INT     NOT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (test_id, agent_id, step)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 049 — raw device-config snapshots (Fase 3). BlueEyes does not capture device
-- running-config today, so this is genuinely new storage. One row per captured
-- config for a device (a device = an agent). Diff-generation between consecutive
-- rows and correlation to incidents build on top of this table.
--
-- config_text is RAW and may contain secrets — reads are operator/admin only
-- (never viewer) and secret-masked at the API layer. captured_via records how the
-- snapshot arrived: manual (pushed by an operator/integration), agent_poll (an
-- agent periodically reporting device config) or change_detected. Only `manual`
-- has a producer today; the others are wired in a later phase.
CREATE TABLE IF NOT EXISTS `config_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  `config_text` MEDIUMTEXT NOT NULL,
  `captured_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `captured_via` ENUM('manual', 'agent_poll', 'change_detected') NOT NULL DEFAULT 'manual',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_config_snapshots_device_captured (device_id, captured_at),
  CONSTRAINT fk_config_snapshots_device FOREIGN KEY (device_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 051 — CMDB integration (single source of truth). Two tables:
--
--   cmdb_config       a SINGLE-ROW connection config for exactly ONE CMDB source
--                     (ServiceNow or Nautobot). Credentials are ENCRYPTED at rest
--                     (AES-256-GCM via src/lib/secretBox.js) in credentials_encrypted
--                     — never plaintext, never returned by the API. verified_at is
--                     stamped when POST /api/settings/cmdb/test reaches the upstream.
--
--   agent_cmdb_links  links a BlueEyes agent to one CMDB asset (searchable dropdown
--                     in the agent detail page). One row per agent (agent_id PK); the
--                     FK cascades on agent delete so a removed agent takes its link.
--
-- Only ONE CMDB source is supported by design (single source of truth), so
-- cmdb_config is treated as a singleton — the repository upserts the lowest-id row.
CREATE TABLE IF NOT EXISTS `cmdb_config` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `type` ENUM('servicenow', 'nautobot', 'custom') NOT NULL,
  `base_url` VARCHAR(512) NOT NULL,
  `auth_type` VARCHAR(32) NOT NULL DEFAULT 'none',
  `config_json` JSON NULL DEFAULT NULL,
  `credentials_encrypted` TEXT NULL DEFAULT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `verified_at` DATETIME NULL DEFAULT NULL,
  `updated_by` INT UNSIGNED NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `agent_cmdb_links` (
  `agent_id` INT UNSIGNED NOT NULL,
  `cmdb_asset_id` VARCHAR(255) NOT NULL,
  `cmdb_asset_name` VARCHAR(255) NOT NULL,
  `cmdb_asset_location` VARCHAR(255) NULL DEFAULT NULL,
  `linked_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `linked_by` INT UNSIGNED NULL DEFAULT NULL,
  PRIMARY KEY (agent_id),
  CONSTRAINT fk_agent_cmdb_links_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 055 — remediation playbooks + their per-incident run history.
--
-- A "remediation playbook" is a pre-defined response tied to an anomaly-type
-- (the incident's primary finding `metric`, e.g. 'cpu', 'io.await'): either an
-- automatic action (`auto_trigger = 1`, `action_type` names the automation) or a
-- manual runbook (`manual_action_text`). The recommendation endpoint
-- (GET /api/incidents/:id/recommendation) looks a playbook up by the incident's
-- primary anomaly-type via `trigger_condition` — an EXACT match, no DSL (local +
-- explainable, consistent with the rest of the analysis stack).
--
-- `incident_playbook_runs` is the incident<->playbook link the recommendation
-- reads: it records that a playbook was executed against a specific incident and
-- how it turned out, so the recommendation can surface the outcome ("already
-- run") instead of re-suggesting the same playbook. Automatic execution /
-- recording of runs is out of scope here — the run table is populated by a later
-- phase; this migration only creates the schema the read path depends on.
CREATE TABLE IF NOT EXISTS `remediation_playbooks` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `trigger_condition` VARCHAR(120) NOT NULL,
  `action_type` VARCHAR(60) NOT NULL,
  `auto_trigger` TINYINT(1) NOT NULL DEFAULT 0,
  `manual_action_text` TEXT NULL DEFAULT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_remediation_playbooks_trigger (trigger_condition, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 059 — durable alert-dispatch log.
--
-- Records each alert actually dispatched to a channel, for TWO purposes:
--   * finding-level rows (subject_type='finding', subject_id = findings.id) let the
--     cross-agent cluster alert REFERENCE the member findings already alerted
--     individually — so it can say "N members already notified" instead of resending;
--   * cluster-level rows (subject_type='cluster', subject_id = incident_clusters.id)
--     make "fire once per cluster" DURABLE — a cluster alerts at most once even across
--     restarts (the dispatcher's throttle is in-memory only).
--
-- Metadata only (ids/metric/severity/channel names) — never payload. Best-effort:
-- the dispatcher writes it after a send and a failure here never affects alerting.
CREATE TABLE IF NOT EXISTS `alert_dispatch_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `subject_type` ENUM('finding', 'cluster') NOT NULL,
  `subject_id` VARCHAR(64) NOT NULL,
  `host_id` VARCHAR(64) NULL DEFAULT NULL,
  `metric` VARCHAR(120) NULL DEFAULT NULL,
  `severity` VARCHAR(16) NULL DEFAULT NULL,
  `channels` VARCHAR(255) NULL DEFAULT NULL,
  `sent_at` DATETIME NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_alert_dispatch_subject (subject_type, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 061 — runbooks: the static finding-type → recommended-action mapping.
--
-- The "Recommended actions" bridge (Fase 3). A runbook maps an anomaly
-- finding-type (e.g. 'cpu', 'probe.loss' — the finding `metric`) to a
-- human-readable, markdown remediation, optionally linked to a remediation
-- playbook (migration 055) so an operator can run it from the incident page.
--
-- Static mapping FIRST, AI second: this table is a zero-latency, zero-AI lookup
-- that covers most cases; the opt-in Mistral advisory (Fase 2) stays garnish.
--
-- `finding_type` is matched EXACTLY against a cluster's dominant finding metrics
-- (no DSL — consistent with remediation_playbooks.trigger_condition). It is NOT
-- unique: several runbooks may target the same finding-type (all are surfaced).
CREATE TABLE IF NOT EXISTS `runbooks` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `finding_type` VARCHAR(120) NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `body_markdown` MEDIUMTEXT NOT NULL,
  `linked_playbook_id` INT UNSIGNED NULL DEFAULT NULL,
  `updated_by` INT UNSIGNED NULL DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_runbooks_finding_type (finding_type),
  CONSTRAINT fk_runbooks_playbook FOREIGN KEY (linked_playbook_id) REFERENCES remediation_playbooks (id) ON DELETE SET NULL,
  CONSTRAINT fk_runbooks_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 062 — verification runs: the "did the fix actually work?" cycle (Fase 3).
--
-- Today a playbook run is logged but nothing re-checks that the original symptoms
-- cleared. When an operator runs a playbook against the targets of an open
-- incident cluster, we record a verification run: after a configurable settle
-- time (default 5 min) a leader-only sweep re-checks the cluster's affected
-- targets for fresh findings of the relevant finding-types, and records the
-- outcome — WITHOUT ever auto-resolving the cluster (clustering informs; humans
-- decide).
--
--   status: pending  — scheduled, settle window not yet elapsed / not yet checked
--           passed    — no fresh symptoms on the affected targets → suggest resolve
--           failed    — symptoms persist → cluster stays open, retry logic (if any)
--           error     — the re-check could not run (surfaced, never silent)
--
-- affected_targets / finding_types are JSON snapshots taken at execution time so
-- the re-check is deterministic even if the cluster changes afterwards. readings
-- holds the fresh findings observed on a failed check (evidence, not a black box).
CREATE TABLE IF NOT EXISTS `verification_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `cluster_id` BIGINT UNSIGNED NOT NULL,
  `playbook_id` INT UNSIGNED NULL DEFAULT NULL,
  `runbook_id` INT UNSIGNED NULL DEFAULT NULL,
  `triggered_by` VARCHAR(190) NULL DEFAULT NULL,
  `affected_targets` JSON NOT NULL,
  `finding_types` JSON NOT NULL,
  `settle_seconds` INT UNSIGNED NOT NULL,
  `executed_at` DATETIME NOT NULL,
  `due_at` DATETIME NOT NULL,
  `status` ENUM('pending', 'passed', 'failed', 'error') NOT NULL DEFAULT 'pending',
  `readings` JSON NULL DEFAULT NULL,
  `completed_at` DATETIME NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_verification_runs_due (status, due_at),
  KEY idx_verification_runs_cluster (cluster_id, executed_at),
  CONSTRAINT fk_verification_runs_cluster FOREIGN KEY (cluster_id) REFERENCES event_clusters (id) ON DELETE CASCADE,
  CONSTRAINT fk_verification_runs_playbook FOREIGN KEY (playbook_id) REFERENCES remediation_playbooks (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 063 — LLDP neighbor relations: a minimal, queryable L2 topology (Fase 4).
--
-- Persists the LLDP neighbor adjacencies an agent observes on its device, so the
-- cross-agent clustering engine (migration 057) can use L2 adjacency as a topology
-- signal when no shared-site (manual) topology groups the findings. This is NOT
-- auto-discovery: rows arrive on the EXISTING agent report path (a `capabilities.
-- lldp` list) — no new SNMP polling here — and stale rows age out.
--
-- `local_chassis_id` is the reporting device's OWN chassis id (from its LLDP local
-- system data). It lets us resolve a neighbor's `remote_chassis_id` back to the
-- agent monitoring that device, turning per-port neighbor rows into an agent↔agent
-- adjacency graph (e.g. "sw-03 adjacent to sw-04"). It is nullable: partial LLDP
-- coverage yields a partial graph (missing edges are treated as UNKNOWN, never as
-- "not adjacent").
--
-- The UNIQUE key is the upsert identity: one row per (agent, local_port, remote
-- chassis, remote_port). Re-observing a neighbor bumps `last_seen`; rows not seen
-- within the configurable age-out window (default 24h) are deleted.
CREATE TABLE IF NOT EXISTS `lldp_neighbors` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `local_agent_id` INT UNSIGNED NOT NULL,
  `local_chassis_id` VARCHAR(190) NULL DEFAULT NULL,
  `local_port` VARCHAR(190) NULL DEFAULT NULL,
  `remote_chassis_id` VARCHAR(190) NOT NULL,
  `remote_port` VARCHAR(190) NULL DEFAULT NULL,
  `link_state` VARCHAR(16) NULL DEFAULT NULL,
  `last_seen` DATETIME NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lldp_edge (local_agent_id, local_port, remote_chassis_id, remote_port),
  KEY idx_lldp_remote (remote_chassis_id),
  KEY idx_lldp_local_chassis (local_chassis_id),
  KEY idx_lldp_last_seen (last_seen),
  CONSTRAINT fk_lldp_local_agent FOREIGN KEY (local_agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 065 — automated evidence snapshots on cluster open (Fase 6).
--
-- When a cross-agent cluster opens, BlueEyes captures a READ-ONLY diagnostic
-- snapshot from each affected target via the existing (authenticated, audited)
-- agent-command path — interface counters, ARP/MAC extract, allowlisted SNMP
-- reads, agent-local state. The result is EVIDENCE, not time series: one
-- compressed blob per (cluster, target), referenced from the incident timeline —
-- NOT rows in metric tables, and never in TimescaleDB.
--
-- Partial results are valid: `items` records each requested command's outcome
-- (ok / timeout / refused / agent-offline) so "what we could and couldn't see" is
-- explicit. Retention follows the existing rule (the age-out job skips snapshots
-- whose cluster still has an unacknowledged CRIT finding; otherwise default 90d).
CREATE TABLE IF NOT EXISTS `cluster_evidence_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `cluster_id` BIGINT UNSIGNED NOT NULL,
  `target` VARCHAR(64) NOT NULL,
  `command_set_version` VARCHAR(32) NOT NULL,
  `status` ENUM('pending', 'complete', 'partial', 'failed', 'agent-offline') NOT NULL DEFAULT 'pending',
  `items` JSON NOT NULL,
  `payload_gzip` MEDIUMBLOB NULL DEFAULT NULL,
  `payload_bytes` INT UNSIGNED NOT NULL DEFAULT 0,
  `captured_at` DATETIME NOT NULL,
  `trigger` VARCHAR(16) NOT NULL DEFAULT 'auto',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_evidence_cluster (cluster_id, captured_at),
  KEY idx_evidence_captured (captured_at),
  CONSTRAINT fk_evidence_cluster FOREIGN KEY (cluster_id) REFERENCES event_clusters (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 066 — service dependency graph edges.
--
-- Directed, aggregated "who-talks-to-whom-on-which-port" edges between two
-- MONITORED hosts, derived from observed TCP flows (never payload). One row per
-- (src_host_id, dst_host_id, dst_port) over a rolling window (default 24h); a
-- leader-only scheduled job (src/topology/serviceDependencyJob.js) recomputes it
-- off the ingest hot path, upserting the current aggregate and ageing out edges
-- not seen within the window. This is the 'service_dep' edge type of the unified
-- topology graph — the LLDP 'l2_link' edges live in `lldp_neighbors` (mig 063);
-- the graph model (src/topology/graph.js) merges both into one typed edge list.
--
-- Both endpoints are always a monitored host = an `agents` row (a plain agent OR
-- an SNMP-monitored device, both represented by an agent id). Edges where either
-- endpoint's IP does not resolve to a known host are dropped by the job and never
-- stored. bytes/packets/conn_count are the summed volume over the window;
-- conn_count is the observed flow count (the closest proxy to connection count
-- from sampled/exported flow data). first_seen/last_seen bound the window the
-- edge was observed in.
--
-- Stored in MySQL (not TimescaleDB): like `lldp_neighbors` this is a mutable,
-- keyed, current-state graph-edge table maintained by upsert + age-out, not
-- append-only telemetry — its natural UNIQUE key excludes time, which a
-- hypertable cannot enforce.
CREATE TABLE IF NOT EXISTS `service_dependencies` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `src_host_id` INT UNSIGNED NOT NULL,
  `dst_host_id` INT UNSIGNED NOT NULL,
  `dst_port` INT UNSIGNED NOT NULL,
  `proto` VARCHAR(16) NOT NULL DEFAULT 'tcp',
  `bytes` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `packets` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `conn_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_dep_edge (src_host_id, dst_host_id, dst_port),
  KEY idx_service_dep_src (src_host_id, bytes),
  KEY idx_service_dep_dst (dst_host_id, bytes),
  KEY idx_service_dep_last_seen (last_seen),
  CONSTRAINT fk_service_dep_src FOREIGN KEY (src_host_id) REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_service_dep_dst FOREIGN KEY (dst_host_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `topology_changes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `change_type` ENUM('neighbour_added','neighbour_removed','link_state_changed','port_moved','flapping') NOT NULL,
  `local_port` VARCHAR(190) NULL DEFAULT NULL,
  `remote_chassis_id` VARCHAR(190) NULL DEFAULT NULL,
  `remote_port` VARCHAR(190) NULL DEFAULT NULL,
  `from_local_port` VARCHAR(190) NULL DEFAULT NULL,
  `link_state_from` VARCHAR(16) NULL DEFAULT NULL,
  `link_state_to` VARCHAR(16) NULL DEFAULT NULL,
  `severity` ENUM('INFO','WARN','CRIT') NOT NULL DEFAULT 'INFO',
  `summary` VARCHAR(512) NOT NULL,
  `detected_at` DATETIME(3) NOT NULL,
  `audit_log_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_topo_changes_agent (agent_id, detected_at),
  KEY idx_topo_changes_chassis (remote_chassis_id),
  KEY idx_topo_changes_detected (detected_at),
  CONSTRAINT fk_topo_changes_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 068 — per-flow-pair traffic-volume baselines.
--
-- Extends per-metric anomaly detection to per-(src_host, dst_host, dst_port).
-- Two tables:
--
-- 1. flow_pair_hourly — an APPEND-ONLY hourly volume rollup per tuple. The
--    service_dependencies table (mig 066) is a current-state snapshot with no
--    history, and raw flow_records is only kept ~7 days, so neither can back a
--    14-day baseline. A leader-only hourly job appends one row per (bucket, tuple)
--    from the same flow_records TCP + host-resolution path the service-dep job
--    uses. Retained >= the baseline window (default 14d); older rows purged.
--    History builds FORWARD from deploy (raw flows can't be backfilled).
--
-- 2. flow_pair_baselines — robust median + MAD baseline per tuple, bucketed by
--    day-of-week + hour-of-day (UTC), recomputed from flow_pair_hourly over the
--    window, reusing src/analysis/baselines.js (no new statistics). A pair needs
--    >= a minimum observation count (default 100 hourly buckets) before it is
--    eligible for scoring. Deviations are emitted to the correlator as ordinary
--    findings (kind ANOMALY) — deviation only, no threat classification.
CREATE TABLE IF NOT EXISTS `flow_pair_hourly` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `bucket` DATETIME NOT NULL,
  `src_host_id` INT UNSIGNED NOT NULL,
  `dst_host_id` INT UNSIGNED NOT NULL,
  `dst_port` INT UNSIGNED NOT NULL,
  `proto` VARCHAR(16) NOT NULL DEFAULT 'tcp',
  `bytes` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `packets` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `conn_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_flow_pair_hourly (bucket, src_host_id, dst_host_id, dst_port),
  KEY idx_flow_pair_hourly_tuple (src_host_id, dst_host_id, dst_port, bucket),
  KEY idx_flow_pair_hourly_bucket (bucket),
  CONSTRAINT fk_flow_pair_hourly_src FOREIGN KEY (src_host_id) REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_flow_pair_hourly_dst FOREIGN KEY (dst_host_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `flow_pair_baselines` (
  `src_host_id` INT UNSIGNED NOT NULL,
  `dst_host_id` INT UNSIGNED NOT NULL,
  `dst_port` INT UNSIGNED NOT NULL,
  `dow` TINYINT UNSIGNED NOT NULL,
  `hour` TINYINT UNSIGNED NOT NULL,
  `median_bytes` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `mad_bytes` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `sample_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `observation_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (src_host_id, dst_host_id, dst_port, dow, hour),
  KEY idx_flow_pair_baseline_src (src_host_id),
  CONSTRAINT fk_flow_pair_baseline_src FOREIGN KEY (src_host_id) REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_flow_pair_baseline_dst FOREIGN KEY (dst_host_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 069 — discovered device candidates (scheduled active discovery).
--
-- Scheduled active discovery finds devices that passive collection (LLDP, sFlow,
-- agents) misses, by probing admin-configured CIDR scope. Results land here as
-- CANDIDATES — they are NEVER auto-enrolled. A candidate becomes a monitored
-- device only when an admin explicitly promotes it (which creates an `agents`
-- row and sets promoted_agent_id + status='promoted').
--
-- This table is intentionally STANDALONE (not an `agents` row) — a candidate is
-- by definition not yet a monitored device. `promoted_agent_id` is nullable and
-- only set on promotion (FK ON DELETE SET NULL so deleting the promoted agent
-- doesn't delete the discovery record).
CREATE TABLE IF NOT EXISTS `discovered_devices` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ip` VARCHAR(45) NOT NULL,
  `hostname` VARCHAR(255) NULL DEFAULT NULL,
  `open_ports` VARCHAR(255) NULL DEFAULT NULL,
  `icmp` TINYINT(1) NOT NULL DEFAULT 0,
  `found_by_agent_id` INT UNSIGNED NULL DEFAULT NULL,
  `status` ENUM('discovered','promoted','ignored') NOT NULL DEFAULT 'discovered',
  `promoted_agent_id` INT UNSIGNED NULL DEFAULT NULL,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_discovered_ip (ip),
  KEY idx_discovered_status (status, last_seen),
  CONSTRAINT fk_discovered_promoted_agent FOREIGN KEY (promoted_agent_id) REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT fk_discovered_found_by_agent FOREIGN KEY (found_by_agent_id) REFERENCES agents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 070 — host connection-table edges (agent-reported service dependencies).
--
-- A second SOURCE for the service dependency graph (mig 066), for hosts that run
-- no flow exporter. The agent reads its OWN established TCP connection table
-- (`ss`/`netstat`/Get-NetTCPConnection — metadata only, never payload) and folds
-- it into directed (src_ip → dst_ip : dst_port) edges from its own perspective,
-- reported alongside its capabilities. One row per (agent_id, src_ip, dst_ip,
-- dst_port); the reporting agent OWNS its rows (replaced wholesale on each
-- report), so a host with the `proc`/`snmp` source still contributes edges.
--
-- These carry a connection COUNT but no byte volume (a connection table has no
-- counters), so the service-dependency job feeds them into the SAME aggregator
-- as the flow rows (bytes/packets = 0, conn_count = the observed count) and the
-- IP→host resolution + unknown-endpoint drop are identical. Stored in MySQL for
-- the same reason as service_dependencies: a mutable, keyed, current-state table.
CREATE TABLE IF NOT EXISTS `host_connections` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `src_ip` VARCHAR(64) NOT NULL,
  `dst_ip` VARCHAR(64) NOT NULL,
  `dst_port` INT UNSIGNED NOT NULL,
  `conn_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_seen` DATETIME NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_host_conn_edge (agent_id, src_ip, dst_ip, dst_port),
  KEY idx_host_conn_last_seen (last_seen),
  CONSTRAINT fk_host_conn_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 073 — ARP/neighbour entries: the IP↔MAC identity source.
--
-- The technician searches for what the phone told them, and sometimes that is a
-- MAC address. Before this table the server had no queryable MAC at all:
--
--   * lldp_neighbors.remote_chassis_id is often a MAC, but it identifies a
--     SWITCH CHASSIS, not a client — wrong answer to "where is this laptop".
--   * arp.table WAS already collected, but only as a gzip blob inside
--     cluster_evidence_snapshots (mig 065): raw command output, unparsed,
--     unindexed, and only for clusters that happened to trigger a capture.
--
-- So the data existed and was unusable. This table parses it into rows.
--
-- TWO INGEST SOURCES, both folding into the same table via `source`:
--   'evidence'    — parsed out of an evidence snapshot's arp.table payload as it
--                   is captured. Needs no agent change, so it works against
--                   agents already in the field, but only fires when a cluster
--                   opens.
--   'capabilities'— the agent reports its own neighbour table on the regular
--                   capabilities cycle. Fresh and continuous, but only from
--                   agents new enough to send it.
-- Neither is authoritative on its own; together they cover the fleet during the
-- rollout, which is why `source` is recorded per row rather than assumed.
--
-- IDENTITY: one row per (agent_id, ip). An IP's MAC changing is an UPDATE, not a
-- second row — the current occupant of an address is what a search must return,
-- and keeping history here would turn an identity lookup into a time query. The
-- previous MAC is not lost silently: `mac_changed_at` marks when the binding
-- last moved, which is exactly the signal that says "this answer may be stale in
-- an interesting way".
--
-- Scoped per agent, not global: the same RFC1918 address legitimately exists at
-- several sites, and collapsing them would resolve 192.168.1.10 to whichever
-- site reported last. The search layer surfaces all matches with their agent.
--
-- PRIVACY: metadata only, consistent with the rest of the product — an address
-- pairing observed on the local segment. No payload, no DPI, no user identity.
-- Broadcast/multicast MACs are dropped by the parser, not stored and filtered.
CREATE TABLE IF NOT EXISTS `arp_entries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `ip` VARCHAR(45) NOT NULL,
  `mac` CHAR(17) NOT NULL,
  `interface` VARCHAR(64) NULL DEFAULT NULL,
  `source` ENUM('evidence', 'capabilities') NOT NULL DEFAULT 'capabilities',
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  `mac_changed_at` DATETIME NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_arp_agent_ip (agent_id, ip),
  KEY idx_arp_mac (mac),
  KEY idx_arp_ip (ip),
  KEY idx_arp_last_seen (last_seen),
  CONSTRAINT fk_arp_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 075 — interface state + state transitions (Fase 2b).
--
-- The changes landing page (mig 074) could report agent up/down and topology
-- link changes, but NOT interface up/down — the one dimension a technician asks
-- about most. Interfaces are not a persisted entity here: interface health is
-- computed on the fly from `results.payload.traffic` by
-- src/health/interfaceHealth.js, so only the CURRENT state ever existed.
--
-- Deriving that history by polling current state was explicitly ruled out: a
-- poller sees whatever state happens to be true when it looks, misses everything
-- between two looks, and produces a change log that quietly lies about when
-- things happened. So this records transitions AT THE SEAM where state is
-- already determined — the results ingest path — which is the only place that
-- sees every observation.
--
-- TWO TABLES, mirroring the lldp_neighbors + topology_changes pair (mig 063/067)
-- that solves the identical problem for L2 links:
--
--   interface_states       the current known state per (agent, iface). Upserted
--                          on every report; it exists ONLY to diff against.
--   interface_state_transitions  one row per actual change. The history.
--
-- A snapshot table rather than "read the latest transition" because an interface
-- that never changes state would have its last transition aged out by retention,
-- and we would then re-announce its state as a change the next time it is seen.
--
-- FLAP SUPPRESSION: an interface that bounces down/up repeatedly is the classic
-- intermittent fault, and it is also the classic way to fill a change feed with
-- 400 rows nobody can read. A transition that REVERSES a recent one (within
-- INTERFACE_FLAP_WINDOW_SECONDS) collapses onto the earlier row as `flapping`
-- with a bumped `flap_count`, exactly as topology_changes does. The signal is
-- preserved — arguably sharpened, since "flapping 14 times" is the finding —
-- without the noise.
--
-- No FK from transitions to states: the two are keyed the same way but have
-- independent lifetimes (states is current, transitions is history under its own
-- retention), and a cascade from one to the other would delete evidence.
CREATE TABLE IF NOT EXISTS `interface_states` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `iface` VARCHAR(190) NOT NULL,
  `status` VARCHAR(16) NOT NULL,
  `oper_status` VARCHAR(32) NULL DEFAULT NULL,
  `virtual` TINYINT(1) NOT NULL DEFAULT 0,
  `first_seen` DATETIME(3) NOT NULL,
  `last_seen` DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_iface_state (agent_id, iface),
  KEY idx_iface_state_last_seen (last_seen),
  CONSTRAINT fk_iface_state_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `interface_state_transitions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `iface` VARCHAR(190) NOT NULL,
  `from_status` VARCHAR(16) NULL DEFAULT NULL,
  `to_status` VARCHAR(16) NOT NULL,
  `oper_status` VARCHAR(32) NULL DEFAULT NULL,
  `severity` ENUM('INFO', 'WARN', 'CRIT') NOT NULL DEFAULT 'INFO',
  `summary` VARCHAR(512) NOT NULL,
  `flap_count` INT UNSIGNED NOT NULL DEFAULT 1,
  `flapping` TINYINT(1) NOT NULL DEFAULT 0,
  `detected_at` DATETIME(3) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_iface_trans_agent (agent_id, detected_at),
  KEY idx_iface_trans_detected (detected_at),
  KEY idx_iface_trans_iface (agent_id, iface, detected_at),
  CONSTRAINT fk_iface_trans_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 047 — incidents as a first-class entity, wrapping analysis findings.
-- One incident_case groups one or more findings (the system's "anomalies") that
-- fire on the same device (host_id) within a correlation window. `severity` is
-- inherited from the highest severity among the linked findings; `title` is
-- auto-generated from the primary finding. Findings link back through
-- findings.incident_case_id (added in migration 048).
--
-- Wrap, not replace: the pre-existing `incidents` table (migration 025, active-
-- probe outages) is a different concept and is left completely untouched. This
-- table's FK is named `primary_finding_id` because the anomaly rows it points at
-- live in `findings` — there is no `anomalies` table in this codebase.
CREATE TABLE IF NOT EXISTS `event_cases` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `host_id` VARCHAR(255) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `status` ENUM('open', 'investigating', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  `severity` ENUM('INFO', 'WARN', 'CRIT') NOT NULL DEFAULT 'INFO',
  `primary_finding_id` CHAR(36) NULL DEFAULT NULL,
  `config_change_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `first_event_at` DATETIME NOT NULL,
  `last_event_at` DATETIME NOT NULL,
  `resolved_at` DATETIME NULL DEFAULT NULL,
  `created_by` ENUM('system', 'manual') NOT NULL DEFAULT 'system',
  `closed_by` INT UNSIGNED NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_event_cases_host_status (host_id, status),
  KEY idx_event_cases_status (status),
  KEY idx_event_cases_last_event (last_event_at),
  KEY idx_event_cases_config_change (config_change_id),
  KEY idx_event_cases_primary_finding (primary_finding_id),
  KEY idx_event_cases_closed_by (closed_by),
  CONSTRAINT fk_event_cases_primary_finding FOREIGN KEY (primary_finding_id) REFERENCES findings (id) ON DELETE SET NULL,
  CONSTRAINT fk_event_cases_closed_by FOREIGN KEY (closed_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_event_cases_config_change FOREIGN KEY (config_change_id) REFERENCES config_snapshots (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 072 — the incident work log (shift handover).
--
-- Intermittent faults run across several shifts. Today nothing survives the
-- handover: agents.notes is overwritten on every PUT, incident_clusters carries a
-- single resolution_note set once at resolve time, findings.acked is a bare
-- boolean with no author and no timestamp, and the comment required to reopen an
-- incident lands only in audit_log.detail. None of that is a log.
--
-- This table is that log. It hangs off incident_cases (migration 047) — the
-- first-class incident the operator actually works, NOT the probe-outage
-- `incidents` of migration 025 and NOT incident_clusters.
--
-- APPEND-ONLY BY CONSTRUCTION. There is no updated_at, no edited_by and no
-- soft-delete column, because the repository exposes no UPDATE and no DELETE:
-- the shape of the table is the contract. A correction is a new entry, which is
-- what you want anyway — the next shift needs to see that something WAS believed
-- and then revised, not a tidied-up final answer.
--
-- `kind` splits the log three ways so the UI can pin the one that matters:
--   observation — something the operator saw
--   action      — something the operator changed or ran
--   ruled_out   — a cause the operator has EXCLUDED
--
-- ruled_out is why this table exists. It is indexed separately (idx_incident_
-- notes_ruled_out) so "what has already been excluded" is one cheap query, and
-- it renders pinned at the top of the panel: it is the first thing the next
-- shift must read, so they do not re-test what someone already disproved.
--
-- author_user_id is nullable with ON DELETE SET NULL (a leaving employee must not
-- take the incident history with them), so author_email/author_role are
-- denormalised snapshots that survive the user row — the same trick audit_log
-- (migration 033) uses.
CREATE TABLE IF NOT EXISTS `event_notes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_case_id` BIGINT UNSIGNED NOT NULL,
  `kind` ENUM('observation', 'action', 'ruled_out') NOT NULL,
  `text` VARCHAR(4000) NOT NULL,
  `author_user_id` INT UNSIGNED NULL DEFAULT NULL,
  `author_email` VARCHAR(255) NULL DEFAULT NULL,
  `author_role` VARCHAR(32) NULL DEFAULT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_event_notes_case (event_case_id, created_at),
  KEY idx_event_notes_ruled_out (event_case_id, kind, created_at),
  KEY idx_event_notes_author (author_user_id),
  CONSTRAINT fk_event_notes_case FOREIGN KEY (event_case_id) REFERENCES event_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_event_notes_author FOREIGN KEY (author_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 057 — cross-agent incident clusters.
--
-- Groups analysis findings that fired on DIFFERENT agents within a short time
-- window into a single "incident cluster" with a suspected common cause and a
-- confidence tier. This is the cross-agent counterpart to the per-target
-- correlator (src/analysis/correlator.js) and the per-device incident_cases
-- (migration 047): those never look across agents; this one does.
--
-- Confidence (weighted signals, low|medium|high — see src/analysis/crossAgentCorrelator.js):
--   time proximity alone .................. low
--   time + shared site (topology) ......... medium
--   time + shared site + same finding-type  high
-- (Topology = a shared site / location_id — the only cross-agent adjacency BlueEyes
--  has today; subnet/VLAN/LLDP are not reported by agents. See docs/cross-agent-correlation.md.)
--
-- member_finding_ids is a JSON array of `findings.id` values (UUID strings). It is
-- kept as JSON (not a join table) to mirror how a finding's own `correlated_with`
-- links are stored — clusters are a lightweight, derived read-model, recomputed
-- from findings, so a join table would add write amplification for no query win.
--
-- `status` starts 'open'; the resolution sweep flips it to 'resolved' once no new
-- member finding has refreshed `detected_at` within the inactivity window (findings
-- carry no explicit "cleared" event, so inactivity is the resolution proxy).
CREATE TABLE IF NOT EXISTS `event_clusters` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `confidence` ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'low',
  `member_finding_ids` JSON NOT NULL,
  `suspected_common_cause` TEXT NULL DEFAULT NULL,
  `advisory` TEXT NULL DEFAULT NULL,
  `alert_last_at` DATETIME NULL DEFAULT NULL,
  `alert_last_severity` VARCHAR(16) NULL DEFAULT NULL,
  `alert_member_count` INT UNSIGNED NULL DEFAULT NULL,
  `itsm_ticket_ref` VARCHAR(190) NULL DEFAULT NULL,
  `itsm_integration_id` INT UNSIGNED NULL DEFAULT NULL,
  `nis2_draft_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `status` ENUM('open', 'acknowledged', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  `detected_at` DATETIME NOT NULL,
  `acknowledged_at` DATETIME NULL DEFAULT NULL,
  `acknowledged_by` INT UNSIGNED NULL DEFAULT NULL,
  `resolved_at` DATETIME NULL DEFAULT NULL,
  `resolved_by` INT UNSIGNED NULL DEFAULT NULL,
  `resolution_note` TEXT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_event_clusters_status_detected (status, detected_at),
  KEY idx_event_clusters_ack_by (acknowledged_by),
  KEY idx_event_clusters_resolved_by (resolved_by),
  CONSTRAINT fk_event_clusters_ack_by FOREIGN KEY (acknowledged_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_event_clusters_resolved_by FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `event_playbook_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_case_id` BIGINT UNSIGNED NOT NULL,
  `playbook_id` INT UNSIGNED NOT NULL,
  `status` ENUM('pending', 'succeeded', 'failed') NOT NULL DEFAULT 'pending',
  `result_text` TEXT NULL DEFAULT NULL,
  `ran_by` VARCHAR(120) NULL DEFAULT NULL,
  `ran_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_event_playbook_runs_event (event_case_id, ran_at),
  KEY idx_event_playbook_runs_playbook (playbook_id),
  CONSTRAINT fk_event_playbook_runs_event FOREIGN KEY (event_case_id) REFERENCES event_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_event_playbook_runs_playbook FOREIGN KEY (playbook_id) REFERENCES remediation_playbooks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 024 — incidents derived from active-probe results. One row per detected
-- outage/degradation for a given (agent, metric, target). started_at is the
-- timestamp of the FIRST failing result in the sequence that breached the
-- threshold (not the result that crossed the debounce count); resolved_at is set
-- once a result comes back under threshold (NULL = still active). At most one
-- ACTIVE incident may exist per (agent_id, metric, affected_target) — enforced in
-- the derivation service (a partial unique index isn't expressible in MySQL).
CREATE TABLE IF NOT EXISTS `probe_outages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `location_id` INT UNSIGNED NULL DEFAULT NULL,
  `agent_id` INT UNSIGNED NOT NULL,
  `metric` ENUM('reachability', 'latency', 'packet_loss') NOT NULL,
  `severity` ENUM('warning', 'critical') NOT NULL,
  `started_at` DATETIME NOT NULL,
  `resolved_at` DATETIME NULL DEFAULT NULL,
  `duration_seconds` INT UNSIGNED NULL DEFAULT NULL,
  `affected_target` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_probe_outages_location_started (location_id, started_at),
  KEY idx_probe_outages_resolved (resolved_at),
  KEY idx_probe_outages_active (agent_id, metric, affected_target, resolved_at),
  CONSTRAINT fk_probe_outages_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_probe_outages_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 023 — incident thresholds. Per-metric cut-offs used to derive incidents from
-- active-probe results (probe_results). A row with location_id = NULL is the
-- GLOBAL default for that metric; a row with a concrete location_id overrides
-- the global for that one site. Lookup: location-specific row wins, else fall
-- back to the global (location_id IS NULL).
--
-- warning_value / critical_value are interpreted per metric:
--   reachability — a failed probe (ok = 0) is always critical; the value
--                  columns are unused (NULL) and kept only for a uniform shape.
--   latency      — rtt_ms >= warning_value => warning, >= critical_value => critical (ms).
--   packet_loss  — loss_pct >= warning_value => warning, >= critical_value => critical (%).
--
-- debounce_count = how many CONSECUTIVE failing results (per agent/metric/target)
-- are required before an incident is opened (default 3), to ride out blips.
CREATE TABLE IF NOT EXISTS `probe_thresholds` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `location_id` INT UNSIGNED NULL DEFAULT NULL,
  `metric` ENUM('reachability', 'latency', 'packet_loss') NOT NULL,
  `warning_value` DOUBLE NULL DEFAULT NULL,
  `critical_value` DOUBLE NULL DEFAULT NULL,
  `debounce_count` INT UNSIGNED NOT NULL DEFAULT 3,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_probe_thresholds_location_metric (location_id, metric),
  CONSTRAINT fk_probe_thresholds_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- settings
-- Runtime-editable module settings, key/JSON, mirroring `app_settings`. Every
-- Service Tests limit (discovery budgets, allowlist caps, runner timeouts,
-- artefact retention) is stored HERE rather than in env vars, so an operator can
-- change it without a redeploy. Code holds the defaults; a row is an override.
-- Module-owned rather than a key in `app_settings` so extraction stays clean.
CREATE TABLE IF NOT EXISTS `service_test_settings` (
  `setting_key` VARCHAR(100) NOT NULL PRIMARY KEY,
  `value` JSON         NOT NULL,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by` INT              DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- applications
CREATE TABLE IF NOT EXISTS `service_test_applications` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT              DEFAULT NULL,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT             DEFAULT NULL,
  `base_url` VARCHAR(1024) NOT NULL,
  `enabled` TINYINT(1)   NOT NULL DEFAULT 1,
  `created_by` INT              DEFAULT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sta_enabled (enabled),
  INDEX idx_sta_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- environments
CREATE TABLE IF NOT EXISTS `service_test_environments` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT              DEFAULT NULL,
  `application_id` INT          NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `base_url` VARCHAR(1024) NOT NULL,
  `type` ENUM('production','staging','development','test','custom') NOT NULL DEFAULT 'custom',
  `enabled` TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ste_app_name (application_id, name),
  INDEX idx_ste_app (application_id),
  CONSTRAINT fk_ste_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- credentials
-- `secret_encrypted` is an AES-256-GCM blob written by src/lib/secretBox.js. It
-- is decrypted ONLY inside the worker, at execution time. No read path on the
-- repository returns it, and no API response, log line or screenshot may contain
-- the plaintext (docs/service-assurance.md §6).
CREATE TABLE IF NOT EXISTS `service_test_credentials` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT              DEFAULT NULL,
  `application_id` INT          NOT NULL,
  `label` VARCHAR(255) NOT NULL,
  `username` VARCHAR(255)     DEFAULT NULL,
  `secret_encrypted` TEXT             DEFAULT NULL,
  `created_by` INT              DEFAULT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS `service_test_allowed_hosts` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT              DEFAULT NULL,
  `application_id` INT          NOT NULL,
  `entry_type` ENUM('host','ip','cidr') NOT NULL,
  `value` VARCHAR(255) NOT NULL,
  `note` VARCHAR(255)     DEFAULT NULL,
  `created_by` INT              DEFAULT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stah_app_value (application_id, value),
  INDEX idx_stah_app (application_id),
  CONSTRAINT fk_stah_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- tests
-- `definition` is the neutral DSL ({ version, name, steps[] }) — it never
-- mentions Playwright. `version` is the test's own revision counter, bumped on
-- every save, with the prior definition kept in service_test_test_versions.
CREATE TABLE IF NOT EXISTS `service_test_tests` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT              DEFAULT NULL,
  `application_id` INT          NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT             DEFAULT NULL,
  `definition` JSON         NOT NULL,
  `version` INT          NOT NULL DEFAULT 1,
  `credential_id` INT              DEFAULT NULL,
  `enabled` TINYINT(1)   NOT NULL DEFAULT 1,
  `created_by` INT              DEFAULT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stt_app (application_id),
  INDEX idx_stt_enabled (enabled),
  CONSTRAINT fk_stt_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_stt_cred FOREIGN KEY (credential_id) REFERENCES service_test_credentials(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Denormalised step rows: the Test Designer's drag & drop order, per-step
-- enable and rename. The `definition` JSON above stays the source of truth for
-- execution; these rows are what the editor reads and reorders.
CREATE TABLE IF NOT EXISTS `service_test_test_steps` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `test_id` INT          NOT NULL,
  `position` INT          NOT NULL,
  `step_type` VARCHAR(40)  NOT NULL,
  `label` VARCHAR(255)     DEFAULT NULL,
  `config` JSON         NOT NULL,
  `enabled` TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stts_test_pos (test_id, position),
  CONSTRAINT fk_stts_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Prior definitions, one row per saved revision (spec §38 — rollback later).
CREATE TABLE IF NOT EXISTS `service_test_test_versions` (
  `id` INT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `test_id` INT      NOT NULL,
  `version` INT      NOT NULL,
  `definition` JSON     NOT NULL,
  `created_by` INT          DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS `service_test_runs` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT              DEFAULT NULL,
  `test_id` INT          NOT NULL,
  `environment_id` INT              DEFAULT NULL,
  `test_version` INT              DEFAULT NULL,
  `status` ENUM('queued','running','pass','fail','warning','skipped','error') NOT NULL DEFAULT 'queued',
  `trigger_source` ENUM('manual','schedule') NOT NULL DEFAULT 'manual',
  `started_at` DATETIME(3)      DEFAULT NULL,
  `ended_at` DATETIME(3)      DEFAULT NULL,
  `duration_ms` INT              DEFAULT NULL,
  `failed_step` INT              DEFAULT NULL,
  `error_message` TEXT             DEFAULT NULL,
  `failure_kind` VARCHAR(60)      DEFAULT NULL,
  `screenshot_path` VARCHAR(512)    DEFAULT NULL,
  `browser` VARCHAR(40)      DEFAULT NULL,
  `console_errors` JSON             DEFAULT NULL,
  `network_errors` JSON             DEFAULT NULL,
  `api_calls` JSON DEFAULT NULL,
  `accessibility` JSON DEFAULT NULL,
  `visual` JSON DEFAULT NULL,
  `claimed_by` VARCHAR(120)     DEFAULT NULL,
  `claimed_at` DATETIME(3)      DEFAULT NULL,
  `requested_by` INT              DEFAULT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_str_test_created (test_id, created_at),
  INDEX idx_str_status (status, created_at),
  CONSTRAINT fk_str_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_str_env FOREIGN KEY (environment_id) REFERENCES service_test_environments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `service_test_run_steps` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `run_id` INT          NOT NULL,
  `position` INT          NOT NULL,
  `step_type` VARCHAR(40)  NOT NULL,
  `label` VARCHAR(255)     DEFAULT NULL,
  `status` ENUM('pass','fail','warning','skipped') NOT NULL,
  `duration_ms` INT              DEFAULT NULL,
  `message` TEXT             DEFAULT NULL,
  `detail` JSON             DEFAULT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_strs_run_pos (run_id, position),
  CONSTRAINT fk_strs_run FOREIGN KEY (run_id) REFERENCES service_test_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- discovery
CREATE TABLE IF NOT EXISTS `service_test_discoveries` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT              DEFAULT NULL,
  `application_id` INT          NOT NULL,
  `environment_id` INT              DEFAULT NULL,
  `login_test_id` INT DEFAULT NULL,
  `credential_id` INT DEFAULT NULL,
  `authenticated` TINYINT(1) NOT NULL DEFAULT 0,
  `session_lost_at_page` INT DEFAULT NULL,
  `auth_note` VARCHAR(512) DEFAULT NULL,
  `status` ENUM('queued','running','complete','failed') NOT NULL DEFAULT 'queued',
  `scope_url` VARCHAR(1024) NOT NULL,
  `budgets` JSON         NOT NULL,
  `page_count` INT          NOT NULL DEFAULT 0,
  `authenticated_page_count` INT NOT NULL DEFAULT 0,
  `form_count` INT          NOT NULL DEFAULT 0,
  `element_count` INT          NOT NULL DEFAULT 0,
  `request_count` INT          NOT NULL DEFAULT 0,
  `login_count` INT          NOT NULL DEFAULT 0,
  `detected_login` JSON DEFAULT NULL,
  `error_message` TEXT             DEFAULT NULL,
  `started_at` DATETIME(3)      DEFAULT NULL,
  `ended_at` DATETIME(3)      DEFAULT NULL,
  `claimed_by` VARCHAR(120)     DEFAULT NULL,
  `claimed_at` DATETIME(3)      DEFAULT NULL,
  `requested_by` INT              DEFAULT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_std_app_created (application_id, created_at),
  INDEX idx_std_status (status, created_at),
  CONSTRAINT fk_std_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_std_env FOREIGN KEY (environment_id) REFERENCES service_test_environments(id) ON DELETE SET NULL,
  KEY idx_std_login_test (login_test_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `service_test_discovery_pages` (
  `id` INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `discovery_id` INT           NOT NULL,
  `url` VARCHAR(1024) NOT NULL,
  `title` VARCHAR(512)      DEFAULT NULL,
  `http_status` INT               DEFAULT NULL,
  `redirected_to` VARCHAR(1024)    DEFAULT NULL,
  `depth` INT           NOT NULL DEFAULT 0,
  `load_ms` INT               DEFAULT NULL,
  `console_errors` JSON            DEFAULT NULL,
  `failed_requests` JSON           DEFAULT NULL,
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stdp_disc (discovery_id),
  CONSTRAINT fk_stdp_disc FOREIGN KEY (discovery_id) REFERENCES service_test_discoveries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per interactive element Discovery saw. `possible_login` is deliberately
-- named as a heuristic: Discovery never claims certainty about a login flow
-- (spec §7). `potentially_destructive` marks an element the crawler recorded but
-- refused to activate (spec §8).
CREATE TABLE IF NOT EXISTS `service_test_discovery_elements` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `discovery_id` INT          NOT NULL,
  `page_id` INT              DEFAULT NULL,
  `kind` ENUM('link','button','input','form','select') NOT NULL,
  `label` VARCHAR(512)     DEFAULT NULL,
  `attributes` JSON         NOT NULL,
  `possible_login` TINYINT(1) NOT NULL DEFAULT 0,
  `potentially_destructive` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stde_disc_kind (discovery_id, kind),
  CONSTRAINT fk_stde_disc FOREIGN KEY (discovery_id) REFERENCES service_test_discoveries(id) ON DELETE CASCADE,
  CONSTRAINT fk_stde_page FOREIGN KEY (page_id) REFERENCES service_test_discovery_pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- suggestions
-- Rule-based proposals derived from a discovery (spec §12 — NOT AI). Accepting
-- one creates a test; a re-run discovery never overwrites existing tests (§37).
CREATE TABLE IF NOT EXISTS `service_test_suggestions` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT              DEFAULT NULL,
  `discovery_id` INT          NOT NULL,
  `application_id` INT          NOT NULL,
  `kind` ENUM('test','journey') NOT NULL DEFAULT 'test',
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT             DEFAULT NULL,
  `confidence` ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  `reason` TEXT             DEFAULT NULL,
  `proposed_steps` JSON         NOT NULL,
  `proposed_journey` JSON DEFAULT NULL,
  `status` ENUM('proposed','accepted','dismissed') NOT NULL DEFAULT 'proposed',
  `created_test_id` INT             DEFAULT NULL,
  `created_journey_id` INT DEFAULT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sts_disc (discovery_id),
  INDEX idx_sts_app_status (application_id, status),
  CONSTRAINT fk_sts_disc FOREIGN KEY (discovery_id) REFERENCES service_test_discoveries(id) ON DELETE CASCADE,
  CONSTRAINT fk_sts_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_sts_test FOREIGN KEY (created_test_id) REFERENCES service_test_tests(id) ON DELETE SET NULL,
  CONSTRAINT fk_stsug_journey FOREIGN KEY (created_journey_id) REFERENCES service_test_journeys(id) ON DELETE SET NULL,
  KEY idx_stsug_kind (application_id, kind, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- schedules
-- interval_sec covers spec §22's fixed choices (60/300/900/3600/86400) without
-- hard-coding them: the UI offers the list, the column stores seconds.
CREATE TABLE IF NOT EXISTS `service_test_schedules` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT              DEFAULT NULL,
  `test_id` INT          NOT NULL,
  `environment_id` INT              DEFAULT NULL,
  `interval_sec` INT          NOT NULL,
  `start_at` DATETIME         DEFAULT NULL,
  `timezone` VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  `enabled` TINYINT(1)   NOT NULL DEFAULT 1,
  `last_run_at` DATETIME(3)      DEFAULT NULL,
  `created_by` INT              DEFAULT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stsch_test_env (test_id, environment_id),
  INDEX idx_stsch_enabled (enabled),
  CONSTRAINT fk_stsch_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_stsch_env FOREIGN KEY (environment_id) REFERENCES service_test_environments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- BlueEye Service Assurance — worker heartbeats.
--
-- Worker liveness used to be inferred from the newest claim on the run queue,
-- which lies in the one case that matters: a freshly started worker that has
-- never claimed anything reads as "no worker connected", so the operator is
-- told to install what is already running. A heartbeat row is written every
-- poll tick, so a worker is visible from the moment it boots.
--
-- One row per worker id (hostname-pid, or SERVICE_TEST_WORKER_ID). Rows are
-- upserted, never accumulated, and a worker that stops simply stops updating
-- last_seen_at.
CREATE TABLE IF NOT EXISTS `service_test_workers` (
  `worker_id` VARCHAR(190) NOT NULL PRIMARY KEY,
  `hostname` VARCHAR(255)     DEFAULT NULL,
  `version` VARCHAR(64)      DEFAULT NULL,
  `started_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_seen_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_stw_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
CREATE TABLE IF NOT EXISTS `service_test_certificates` (
  `id` INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT               DEFAULT NULL,
  `application_id` INT           NOT NULL,
  `environment_id` INT               DEFAULT NULL,
  `host` VARCHAR(255)  NOT NULL,
  `port` INT           NOT NULL DEFAULT 443,
  `url` VARCHAR(1024)     DEFAULT NULL,
  `subject` VARCHAR(512)      DEFAULT NULL,
  `issuer` VARCHAR(512)      DEFAULT NULL,
  `serial_number` VARCHAR(128)      DEFAULT NULL,
  `fingerprint` VARCHAR(190)      DEFAULT NULL,
  `alt_names` TEXT              DEFAULT NULL,
  `valid_from` DATETIME          DEFAULT NULL,
  `valid_to` DATETIME          DEFAULT NULL,
  `days_remaining` INT               DEFAULT NULL,
  `status` ENUM('ok','expiring','expired','invalid','unreachable') NOT NULL DEFAULT 'ok',
  `error_message` TEXT              DEFAULT NULL,
  `checked_at` DATETIME(3)       DEFAULT NULL,
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS `service_test_incidents` (
  `id` INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT              DEFAULT NULL,
  `application_id` INT              DEFAULT NULL,
  `environment_id` INT              DEFAULT NULL,
  `test_id` INT              DEFAULT NULL,
  `subject_type` ENUM('test','certificate','monitor') NOT NULL,
  `subject_key` VARCHAR(190) NOT NULL,
  `subject_label` VARCHAR(255)     DEFAULT NULL,
  `kind` VARCHAR(60)  NOT NULL,
  `severity` ENUM('INFO','WARN','CRIT') NOT NULL DEFAULT 'WARN',
  `original_severity` ENUM('INFO','WARN','CRIT') DEFAULT NULL,
  `severity_rule_id` INT DEFAULT NULL,
  `status` ENUM('open','investigating','identified','resolved','closed')
    NOT NULL DEFAULT 'open',
  `summary` TEXT             DEFAULT NULL,
  `likely_cause` VARCHAR(255)     DEFAULT NULL,
  `correlated_layer` VARCHAR(32) DEFAULT NULL,
  `confidence` TINYINT UNSIGNED DEFAULT NULL,
  `impact` ENUM('low','medium','high','critical') DEFAULT NULL,
  `impact_reason` VARCHAR(512) DEFAULT NULL,
  `affected_journeys` JSON DEFAULT NULL,
  `explanation` TEXT             DEFAULT NULL,
  `evidence` JSON             DEFAULT NULL,
  `occurrences` INT          NOT NULL DEFAULT 1,
  `opened_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_seen_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `resolved_at` DATETIME(3)      DEFAULT NULL,
  `resolved_by` INT              DEFAULT NULL,
  `acknowledged_at` DATETIME(3) DEFAULT NULL,
  `acknowledged_by` INT DEFAULT NULL,
  `resolution` VARCHAR(255)     DEFAULT NULL,
  `notified_at` DATETIME(3)      DEFAULT NULL,
  `notified_severity` ENUM('INFO','WARN','CRIT') DEFAULT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sti_open (subject_key, status),
  INDEX idx_sti_status (status, severity, last_seen_at),
  INDEX idx_sti_app (application_id, status),
  CONSTRAINT fk_sti_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_sti_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_sti_severity_rule FOREIGN KEY (severity_rule_id) REFERENCES event_severity_rules(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
CREATE TABLE IF NOT EXISTS `service_test_recordings` (
  `id` INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT               DEFAULT NULL,
  `application_id` INT           NOT NULL,
  `name` VARCHAR(255)  NOT NULL,
  `status` ENUM('recording','stopped','accepted') NOT NULL DEFAULT 'recording',
  `token_hash` CHAR(64)      NOT NULL,
  `events` JSON              DEFAULT NULL,
  `event_count` INT           NOT NULL DEFAULT 0,
  `base_url` VARCHAR(1024)     DEFAULT NULL,
  `created_test_id` INT              DEFAULT NULL,
  `created_by` INT               DEFAULT NULL,
  `expires_at` DATETIME(3)   NOT NULL,
  `last_event_at` DATETIME(3)       DEFAULT NULL,
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_str_app (application_id, status),
  INDEX idx_str_expiry (expires_at),
  CONSTRAINT fk_strec_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_strec_test FOREIGN KEY (created_test_id) REFERENCES service_test_tests(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
CREATE TABLE IF NOT EXISTS `service_test_journeys` (
  `id` INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT               DEFAULT NULL,
  `application_id` INT           NOT NULL,
  `name` VARCHAR(255)  NOT NULL,
  `description` TEXT              DEFAULT NULL,
  `criticality` ENUM('critical','high','normal','low') NOT NULL DEFAULT 'normal',
  `expected_duration_ms` INT         DEFAULT NULL,
  `environment_id` INT               DEFAULT NULL,
  `enabled` TINYINT(1)    NOT NULL DEFAULT 1,
  `created_by` INT               DEFAULT NULL,
  `updated_by` INT               DEFAULT NULL,
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS `service_test_journey_steps` (
  `id` INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `journey_id` INT           NOT NULL,
  `test_id` INT           NOT NULL,
  `position` INT           NOT NULL,
  `label` VARCHAR(255)      DEFAULT NULL,
  `required` TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stjs_journey_test (journey_id, test_id),
  INDEX idx_stjs_order (journey_id, position),
  INDEX idx_stjs_test (test_id),
  CONSTRAINT fk_stjs_journey FOREIGN KEY (journey_id) REFERENCES service_test_journeys(id) ON DELETE CASCADE,
  CONSTRAINT fk_stjs_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
CREATE TABLE IF NOT EXISTS `service_test_healing` (
  `id` INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT               DEFAULT NULL,
  `test_id` INT           NOT NULL,
  `run_id` INT               DEFAULT NULL,
  `step_path` VARCHAR(40)   NOT NULL,
  `step_type` VARCHAR(40)       DEFAULT NULL,
  `original_target` JSON         NOT NULL,
  `proposed_target` JSON         NOT NULL,
  `confidence` ENUM('high','medium','low') NOT NULL DEFAULT 'low',
  `reason` TEXT              DEFAULT NULL,
  `score` INT               DEFAULT NULL,
  `status` ENUM('proposed','accepted','rejected','stale') NOT NULL DEFAULT 'proposed',
  `applied_by` INT               DEFAULT NULL,
  `decided_at` DATETIME(3)       DEFAULT NULL,
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sth_test (test_id, status),
  INDEX idx_sth_step (test_id, step_path, status),
  INDEX idx_sth_run (run_id),
  CONSTRAINT fk_sth_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_sth_run FOREIGN KEY (run_id) REFERENCES service_test_runs(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Severity rules — "this kind of event is a warning for us, not a critical".
--
-- BlueEyes decides severity at detection time: the analysis detector from a MAD
-- z-score, Service Assurance from the kind of failure. Both are reasonable
-- defaults and neither knows your business. A packet-loss anomaly that pages one
-- customer at 3am is background noise to another.
--
-- So a rule says: events matching THIS get THAT severity, from now on.
--
-- WHAT THIS IS NOT: a mute button. A rule can move an event to INFO; it can
-- never make one disappear. Something that silently deletes events is a
-- different and far more dangerous control, and it is not going to hide behind
-- this one.
--
-- Applied at STORE time, not at read time. That is deliberate:
--
--   * alerting reads the stored severity, and not paging on it is the whole
--     point of the feature;
--   * history stays a record of what was decided AT THE TIME. With read-time
--     rules, a rule written today would silently rewrite what you thought last
--     March, and "why did nobody act on this" becomes unanswerable.
--
-- Existing open events are therefore NOT touched by writing a rule. Applying one
-- backwards is a separate, explicit action with its own count and audit entry.
CREATE TABLE IF NOT EXISTS `event_severity_rules` (
  `id` INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT               DEFAULT NULL,
  `source` ENUM('finding','service_assurance') NOT NULL,
  `match_metric` VARCHAR(255)      DEFAULT NULL,
  `match_kind` VARCHAR(60)       DEFAULT NULL,
  `match_host_id` VARCHAR(255)      DEFAULT NULL,
  `match_application_id` INT         DEFAULT NULL,
  `severity` ENUM('INFO','WARN','CRIT') NOT NULL,
  `reason` TEXT              DEFAULT NULL,
  `enabled` TINYINT(1)    NOT NULL DEFAULT 1,
  `applied_count` INT           NOT NULL DEFAULT 0,
  `last_applied_at` DATETIME(3)      DEFAULT NULL,
  `created_by` INT               DEFAULT NULL,
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_esr_source (source, enabled),
  CONSTRAINT fk_esr_application FOREIGN KEY (match_application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Visual regression baselines (V2 §8).
--
-- A baseline is "this is what this step is supposed to look like". One per
-- (test, step, environment): the same journey against staging and production
-- legitimately looks different, and one shared baseline would report that
-- difference forever.
--
-- The IMAGE lives on disk beside the run screenshots, under the same root, the
-- same retention plumbing and the same cleanup. Only the path is stored here.
-- A few hundred baselines as MySQL blobs would turn every dump into hundreds of
-- megabytes and slow every backup, to solve a problem the artifact store already
-- solves.
--
-- Opt-in per step, per the spec. Nothing is compared until somebody accepts a
-- baseline, because a baseline captured automatically on first sight is a
-- baseline of whatever the page happened to look like that day — including
-- broken.
CREATE TABLE IF NOT EXISTS `service_test_baselines` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `test_id` INT NOT NULL,
  `step_index` INT NOT NULL,
  `step_label` VARCHAR(255) DEFAULT NULL,
  `environment_id` INT DEFAULT NULL,
  `image_path` VARCHAR(512) NOT NULL,
  `width` INT DEFAULT NULL,
  `height` INT DEFAULT NULL,
  `ignore_regions` JSON DEFAULT NULL,
  `tolerance` INT DEFAULT NULL,
  `threshold_pct` DECIMAL(5,2) DEFAULT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `accepted_by` INT DEFAULT NULL,
  `accepted_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `source_run_id` INT DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stbase_step (test_id, step_index, environment_id),
  KEY idx_stbase_test (test_id, enabled),
  CONSTRAINT fk_stbase_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_stbase_env FOREIGN KEY (environment_id) REFERENCES service_test_environments(id) ON DELETE CASCADE,
  CONSTRAINT fk_stbase_run FOREIGN KEY (source_run_id) REFERENCES service_test_runs(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- V3 Phase 1: the observation model (docs/service-assurance-v3.md).
--
-- An OBSERVATION is one typed fact a run produced, with a source. Everything
-- V3 reasons over — correlation, root cause, incidents, health — reads
-- observations rather than re-parsing screenshots, error strings and prose.
--
-- Why a table rather than another JSON column on the run: correlation asks
-- questions ACROSS runs ("has this API failed before", "did the network look
-- fine every time"), and a JSON blob per run cannot be queried that way without
-- reading every row. This is the first thing in the module that is genuinely
-- relational.
--
-- Written by the run, never by a person. An observation is what was seen; if it
-- can be edited it is an opinion, and the whole point is that the evidence
-- underneath a conclusion is not editable.
CREATE TABLE IF NOT EXISTS `service_observations` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `run_id` INT DEFAULT NULL,
  `test_id` INT DEFAULT NULL,
  `journey_id` INT DEFAULT NULL,
  `application_id` INT DEFAULT NULL,
  `environment_id` INT DEFAULT NULL,
  `layer` ENUM('browser','page','api','application','server','network','infrastructure','assurance')
    NOT NULL,
  `kind` VARCHAR(64) NOT NULL,
  `subject` VARCHAR(512) DEFAULT NULL,
  `outcome` ENUM('ok','bad','unknown') NOT NULL DEFAULT 'unknown',
  `value` DOUBLE DEFAULT NULL,
  `unit` VARCHAR(32) DEFAULT NULL,
  `summary` VARCHAR(512) DEFAULT NULL,
  `detail` JSON DEFAULT NULL,
  `observed_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_obs_app_time (application_id, observed_at),
  KEY idx_obs_layer (application_id, layer, outcome, observed_at),
  KEY idx_obs_subject (application_id, kind, subject(191), observed_at),
  KEY idx_obs_run (run_id),
  KEY idx_obs_journey (journey_id, observed_at),
  CONSTRAINT fk_obs_run FOREIGN KEY (run_id) REFERENCES service_test_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_obs_test FOREIGN KEY (test_id) REFERENCES service_test_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_obs_journey FOREIGN KEY (journey_id) REFERENCES service_test_journeys(id) ON DELETE SET NULL,
  CONSTRAINT fk_obs_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_obs_env FOREIGN KEY (environment_id) REFERENCES service_test_environments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The timeline.
--
-- Built from events that ACTUALLY HAPPENED, each with the time it happened —
-- not a narrative composed afterwards. That is the whole requirement: an
-- operator reading "14:07 service marked DEGRADED" must be able to trust that
-- something marked it degraded at 14:07.
--
-- Append-only in practice: rows are written as things occur and never edited.
-- A timeline that can be rewritten is a timeline nobody can rely on during a
-- post-mortem, which is exactly when it is read.
CREATE TABLE IF NOT EXISTS `service_incident_events` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `incident_id` INT NOT NULL,
  `kind` VARCHAR(64) NOT NULL,
  `summary` VARCHAR(512) NOT NULL,
  `detail` JSON DEFAULT NULL,
  `source` ENUM('run','sweep','correlation','rule','person','notification') NOT NULL DEFAULT 'run',
  `actor_id` INT DEFAULT NULL,
  `occurred_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sie_incident (incident_id, occurred_at, id),
  CONSTRAINT fk_sie_incident FOREIGN KEY (incident_id) REFERENCES service_test_incidents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
CREATE TABLE IF NOT EXISTS `service_ai_analyses` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `incident_id` INT DEFAULT NULL,
  `application_id` INT DEFAULT NULL,
  `kind` VARCHAR(64) NOT NULL,
  `answer` TEXT NOT NULL,
  `model` VARCHAR(120) DEFAULT NULL,
  `context` JSON DEFAULT NULL,
  `duration_ms` INT DEFAULT NULL,
  `requested_by` INT DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ai_incident (incident_id, created_at),
  KEY idx_ai_application (application_id, created_at),
  KEY idx_ai_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
CREATE TABLE IF NOT EXISTS `service_monitors` (
  `id` INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT               DEFAULT NULL,
  `application_id` INT               DEFAULT NULL,
  `environment_id` INT               DEFAULT NULL,
  `name` VARCHAR(255)  NOT NULL,
  `type` VARCHAR(32)   NOT NULL,
  `target` VARCHAR(255)  NOT NULL,
  `description` TEXT              DEFAULT NULL,
  `config` JSON          NOT NULL,
  `secrets_encrypted` TEXT           DEFAULT NULL,
  `interval_sec` INT           NOT NULL DEFAULT 900,
  `warn_ms` INT               DEFAULT NULL,
  `crit_ms` INT               DEFAULT NULL,
  `enabled` TINYINT(1)    NOT NULL DEFAULT 1,
  `activated_at` DATETIME(3) NULL DEFAULT NULL,
  `last_run_at` DATETIME(3)       DEFAULT NULL,
  `last_status` VARCHAR(24)       DEFAULT NULL,
  `last_summary` VARCHAR(512)      DEFAULT NULL,
  `last_duration_ms` INT             DEFAULT NULL,
  `consecutive_failures` INT     NOT NULL DEFAULT 0,
  `created_by` INT               DEFAULT NULL,
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_smon_name (name),
  INDEX idx_smon_due (enabled, last_run_at),
  INDEX idx_smon_app (application_id),
  INDEX idx_smon_type (type),
  CONSTRAINT fk_smon_app FOREIGN KEY (application_id) REFERENCES service_test_applications(id) ON DELETE SET NULL,
  CONSTRAINT fk_smon_env FOREIGN KEY (environment_id) REFERENCES service_test_environments(id) ON DELETE SET NULL
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
CREATE TABLE IF NOT EXISTS `service_monitor_results` (
  `id` BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tenant_id` INT               DEFAULT NULL,
  `monitor_id` INT           NOT NULL,
  `status` ENUM('ok','slow','failed','unreachable','misconfigured','unknown')
                 NOT NULL DEFAULT 'unknown',
  `kind` VARCHAR(48)       DEFAULT NULL,
  `duration_ms` INT               DEFAULT NULL,
  `value` DOUBLE            DEFAULT NULL,
  `unit` VARCHAR(16)       DEFAULT NULL,
  `summary` VARCHAR(512)      DEFAULT NULL,
  `error_message` TEXT              DEFAULT NULL,
  `timings` JSON              DEFAULT NULL,
  `detail` JSON              DEFAULT NULL,
  `trigger_source` ENUM('schedule','manual') NOT NULL DEFAULT 'schedule',
  `requested_by` INT               DEFAULT NULL,
  `checked_at` DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_smonr_monitor (monitor_id, checked_at),
  INDEX idx_smonr_status (status, checked_at),
  CONSTRAINT fk_smonr_monitor FOREIGN KEY (monitor_id) REFERENCES service_monitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
CREATE TABLE IF NOT EXISTS `diagnose_sessions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `description` VARCHAR(1000) NOT NULL,
  `locale` VARCHAR(8) NOT NULL DEFAULT 'en',
  `matched_by` ENUM('keywords', 'llm') NOT NULL DEFAULT 'keywords',
  `agent_id` INT UNSIGNED NULL DEFAULT NULL,
  `peer_agent_id` INT UNSIGNED NULL DEFAULT NULL,
  `target` VARCHAR(255) NULL DEFAULT NULL,
  `entities` JSON NULL DEFAULT NULL,
  `plan` JSON NOT NULL,
  `evaluation` JSON NULL DEFAULT NULL,
  `status` ENUM('planned', 'running', 'evaluated') NOT NULL DEFAULT 'planned',
  `created_by` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_diagnose_sessions_created (created_at),
  KEY idx_diagnose_sessions_agent (agent_id, created_at),
  CONSTRAINT fk_diagnose_sessions_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT fk_diagnose_sessions_peer FOREIGN KEY (peer_agent_id) REFERENCES agents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `diagnose_session_tests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` BIGINT UNSIGNED NOT NULL,
  `playbook_id` VARCHAR(64) NOT NULL,
  `agent_id` INT UNSIGNED NULL DEFAULT NULL,
  `direction` ENUM('forward', 'reverse') NOT NULL DEFAULT 'forward',
  `probe_type` VARCHAR(16) NOT NULL,
  `target` VARCHAR(255) NOT NULL,
  `params` JSON NULL DEFAULT NULL,
  `status` ENUM('pending', 'dispatched', 'complete', 'failed') NOT NULL DEFAULT 'pending',
  `dispatched_at` DATETIME NULL DEFAULT NULL,
  `probe_result_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `detail` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_diagnose_tests_session (session_id, id),
  KEY idx_diagnose_tests_lookup (agent_id, probe_type, target, dispatched_at),
  CONSTRAINT fk_diagnose_tests_session FOREIGN KEY (session_id) REFERENCES diagnose_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_diagnose_tests_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 100 — reports that arrive on their own.
--
-- The availability and probe-outage reports are exports: somebody opens the
-- Reporting page, picks a period and downloads a file. That is the right shape
-- for answering a question, and the wrong shape for the recurring obligation
-- those two reports usually serve — the monthly SLA figure for a customer, the
-- weekly outage list for a service review. A report nobody remembers to pull is
-- a report that is missing on the day it is asked for.
--
-- A schedule says WHICH report, over how long a window, for whom, and how often:
--
--   report        'availability' | 'probe_outages' — the two the exports cover
--   format        'csv' | 'html' — the same two renderings, as an attachment
--   window_days   the period is RELATIVE and computed at fire time ("the last
--                 7 days"), never a stored from/to, which would send the same
--                 fortnight forever
--   params        the report's own filters (location_id, severity)
--   schedule_spec the recurrence from migration 099 — the same calendar the
--                 test packages use, so "the 1st at 06:00" means one thing in
--                 this product
--   recipients    who it goes to; delivery is the alerting SMTP settings, so an
--                 admin configures a mail server once
--
-- last_run_at / last_run_status are the honest half: a schedule that has been
-- failing to send for three weeks must say so on the screen that created it,
-- rather than looking healthy because nothing threw where anyone could see.
CREATE TABLE IF NOT EXISTS `report_schedules` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `report` VARCHAR(32) NOT NULL,
  `format` VARCHAR(8) NOT NULL DEFAULT 'csv',
  `window_days` SMALLINT UNSIGNED NOT NULL DEFAULT 7,
  `params` JSON NULL DEFAULT NULL,
  `schedule_spec` JSON NOT NULL,
  `recipients` JSON NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` VARCHAR(255) NULL DEFAULT NULL,
  `last_run_at` DATETIME NULL DEFAULT NULL,
  `last_run_status` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_report_schedules_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 103 — device_events: what the network equipment itself says.
--
-- Until now the server could see that something broke (anomaly findings, probe
-- outages) but not why. The devices already say why — link flaps, STP topology
-- changes, OSPF adjacency drops, DHCP pool exhaustion — and nothing listened.
-- The agent listens now (blueeye-agent src/syslog/), and this is where what it
-- hears lands.
--
-- ONE TABLE FOR SYSLOG AND TRAPS. `transport` is an ENUM with both values from
-- the start even though only 'syslog' is written today. An SNMP trap and a
-- syslog line are the same thing arriving over a different socket: same sender,
-- same device, same event_type vocabulary, same place on the timeline. Adding
-- the column later would mean a second migration against a table that by then
-- holds millions of rows, and a second ingest path to keep in step with this
-- one. The cost of deciding now is one unused enum value.
--
-- NO FOREIGN KEYS. This is TELEMETRY by the classification in
-- docs/storage-split-audit.md — HIGH write volume, and bound for TimescaleDB
-- when TSDB is enabled (the repository has a MySQL and a TSDB implementation,
-- the same dual-store pattern `results` and `probe_results` use). A hypertable
-- cannot carry an FK into MySQL, so `agent_id` and `device_id` are plain
-- integers here for exactly the reason transaction_results (046) has none.
--
-- WHY device_id IS NULLABLE. The sender is resolved from its IP against
-- arp_entries and the SNMP monitor targets. When that fails — a device nobody
-- has ARPed yet, a relay forwarding on someone else's behalf — the row is still
-- stored, with device_id NULL and source_ip intact. Discarding it would lose
-- the one message that explains an outage because the inventory was incomplete,
-- which is precisely when inventories are incomplete.
--
-- WHY clock_skew_ms IS A COLUMN. Switches keep bad time. A device whose clock
-- is three seconds behind silently ruins every correlation built on its
-- timestamps, and an operator reading the log has no way to tell. Storing the
-- measured difference between the device's own stamp and the moment the agent
-- received the line puts that failure on the screen instead of inside the data.
-- NULL means the line carried no device time at all, which is not zero skew.
--
-- DEDUP. `dedup_key` is nullable + UNIQUE, the same mechanism audit_events (035)
-- uses to fold recurring activity onto one row. The key the ingest builds
-- INCLUDES A TIME BUCKET, so folding is bounded to a window: a link flap today
-- never merges into one from last week, and a rate that changes over time stays
-- visible as separate rows. NULL opts a row out of folding entirely.
CREATE TABLE IF NOT EXISTS `device_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `device_id` INT UNSIGNED NULL DEFAULT NULL,
  `source_ip` VARCHAR(45) NOT NULL,
  `received_at` DATETIME(3) NOT NULL,
  `device_time` DATETIME(3) NULL DEFAULT NULL,
  `clock_skew_ms` INT NULL DEFAULT NULL,
  `transport` ENUM('syslog', 'trap') NOT NULL DEFAULT 'syslog',
  `facility` TINYINT UNSIGNED NULL DEFAULT NULL,
  `severity` TINYINT UNSIGNED NOT NULL,
  `event_type` VARCHAR(64) NOT NULL DEFAULT 'syslog.raw',
  `device_hostname` VARCHAR(255) NULL DEFAULT NULL,
  `tag` VARCHAR(64) NULL DEFAULT NULL,
  `ifname` VARCHAR(64) NULL DEFAULT NULL,
  `summary` VARCHAR(512) NOT NULL,
  `raw` TEXT NULL DEFAULT NULL,
  `detail` JSON NULL DEFAULT NULL,
  `dedup_key` VARCHAR(160) NULL DEFAULT NULL,
  `occurrences` INT UNSIGNED NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device_events_dedup` (`dedup_key`),
  KEY `idx_device_events_received` (`received_at`),
  KEY `idx_device_events_device` (`device_id`, `received_at`),
  KEY `idx_device_events_type` (`event_type`, `received_at`),
  KEY `idx_device_events_severity` (`severity`, `received_at`),
  KEY `idx_device_events_agent` (`agent_id`, `received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 104 — snmp_devices: the switches an agent polls ON BEHALF OF the server.
--
-- WHAT THIS BREAKS, AND WHY IT HAD TO BREAK.
--
-- SNMP already existed here, bound 1:1. `agents.monitor_config.source = 'snmp'`
-- makes the WHOLE agent poll one remote device instead of its own /proc, so a
-- site with twelve switches needed twelve agents. And `insertSnmpDevice()`
-- (agentsRepository) creates an `agents` row with the sentinel platform 'snmp'
-- when an admin promotes a discovered candidate — a row nothing ever polls.
--
-- This table breaks the binding: one agent polls MANY devices, ALONGSIDE its own
-- traffic sampling. `monitor_config` is untouched, so every agent in the field
-- keeps working exactly as before; an agent too old to understand `snmpTargets`
-- ignores an unknown config key, which is the contract we already rely on.
--
-- WHY IT IS NOT AN `agents` ROW. A polled switch is not an agent: it has no
-- token, no WebSocket, no version, no heartbeat, and no self-update. Modelling
-- it as one means every fleet-health rollup, every "agents behind" badge and
-- every licence seat count has to learn to exclude it — and each of those is a
-- place to get it wrong later. `agent_id` here says WHO POLLS IT, which is a
-- different fact.
--
-- WHY THE COMMUNITY STRING IS AES-256-GCM AT REST. An SNMPv2c community is a
-- password in clear text on the wire; that is the protocol's fault and we cannot
-- fix it. What we can refuse to do is keep it readable in the database or hand
-- it back on a GET. Same secretBox treatment as `cmdb_config` and
-- `integrations`, decrypted only when the config is handed to the agent over the
-- already-authenticated channel.
--
-- SSRF. `host` is validated against the Service Assurance host policy on write
-- AND again before a poll is dispatched — the same two-check rule, because a
-- row written before an allowlist narrowed must not keep reaching a target the
-- policy now refuses.
CREATE TABLE IF NOT EXISTS `snmp_devices` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NULL DEFAULT NULL,
  `host` VARCHAR(255) NOT NULL,
  `port` SMALLINT UNSIGNED NOT NULL DEFAULT 161,
  `version` ENUM('1', '2c', '3') NOT NULL DEFAULT '2c',
  `community_encrypted` TEXT NULL DEFAULT NULL,
  `credential_profile_id` INT UNSIGNED NULL DEFAULT NULL,
  `display_name` VARCHAR(255) NULL DEFAULT NULL,
  `location_id` INT UNSIGNED NULL DEFAULT NULL,
  `collect` JSON NULL DEFAULT NULL,
  `interval_sec` INT UNSIGNED NOT NULL DEFAULT 300,
  `counter_interval_sec` INT UNSIGNED NULL DEFAULT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `last_polled_at` DATETIME NULL DEFAULT NULL,
  `last_ok_at` DATETIME NULL DEFAULT NULL,
  `last_error` VARCHAR(255) NULL DEFAULT NULL,
  `last_uptime_ticks` BIGINT UNSIGNED NULL DEFAULT NULL,
  `last_uptime_at` DATETIME(3) NULL DEFAULT NULL,
  `supported` JSON NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_snmp_devices_host` (`host`, `port`),
  KEY `idx_snmp_devices_agent` (`agent_id`, `enabled`),
  CONSTRAINT `fk_snmp_devices_agent` FOREIGN KEY (`agent_id`) REFERENCES `agents` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_snmp_devices_location` FOREIGN KEY (`location_id`) REFERENCES `locations` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_snmp_devices_profile` FOREIGN KEY (`credential_profile_id`) REFERENCES `snmp_credential_profiles` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 105 — fdb_entries: which switch port a MAC address is on.
--
-- THE QUESTION THIS ANSWERS. "The printer on the second floor is offline" ends,
-- eventually, at a physical port on a physical switch. Until now BlueEyes could
-- get as far as IP↔MAC (arp_entries, migration 073) and stop: an agent's
-- neighbour cache knows that 192.168.20.84 is 00:1b:44:11:3a:b7, and nothing
-- knew that 00:1b:44:11:3a:b7 is on sw-acc-2 Gi0/14. That last hop is the one
-- that sends somebody to the right patch panel.
--
-- BRIDGE PORT IS NOT ifIndex. This is the detail the whole table rests on.
-- dot1qTpFdbPort/dot1dTpFdbPort give a BRIDGE PORT NUMBER, which is an index
-- into dot1dBasePortTable — not the ifIndex that names the interface. On plenty
-- of switches they happen to coincide for the first few ports and then diverge,
-- which is worse than never matching, because it produces an answer that is
-- right in the lab and wrong in the building. So the agent walks
-- dot1dBasePortIfIndex and resolves the mapping BEFORE reporting, and both
-- numbers are stored: `bridge_port` as the device said it, `if_index` and
-- `if_name` as resolved. When the resolution fails, if_index/if_name are NULL
-- and the row still records where it came from, rather than inventing a port.
--
-- WHY VLAN IS IN THE PRIMARY KEY. Q-BRIDGE learns per VLAN. The same MAC can
-- legitimately appear in two VLANs on the same switch (a router sub-interface,
-- a device on a voice and a data VLAN), and folding those into one row would
-- silently discard a real observation. Devices that only implement the older
-- BRIDGE-MIB report no VLAN; those rows use vlan 0, which is not a real VLAN id
-- and is therefore unambiguous as "the device did not say".
--
-- AGEING, NOT HISTORY. A forwarding table is a snapshot of a moment. Rows are
-- upserted on last_seen and aged out by retention; there is no history table,
-- because "where was this MAC three weeks ago" is a question a forwarding
-- database cannot honestly answer — the entry ages out of the SWITCH in minutes.
-- What matters for search is first_seen/last_seen, so a stale answer is
-- visibly stale rather than confidently wrong. Same rule arp_entries follows.
CREATE TABLE IF NOT EXISTS `fdb_entries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  `mac` CHAR(17) NOT NULL,
  `vlan` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `bridge_port` INT UNSIGNED NOT NULL,
  `prev_bridge_port` INT UNSIGNED NULL DEFAULT NULL,
  `move_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_move_at` DATETIME NULL DEFAULT NULL,
  `if_index` INT UNSIGNED NULL DEFAULT NULL,
  `if_name` VARCHAR(64) NULL DEFAULT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'learned',
  `port_mac_count` INT UNSIGNED NOT NULL DEFAULT 1,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fdb_device_vlan_mac` (`device_id`, `vlan`, `mac`),
  KEY `idx_fdb_mac` (`mac`, `last_seen`),
  KEY `idx_fdb_device_port` (`device_id`, `bridge_port`),
  KEY `idx_fdb_last_seen` (`last_seen`),
  CONSTRAINT `fk_fdb_device` FOREIGN KEY (`device_id`) REFERENCES `snmp_devices` (`id`) ON DELETE CASCADE,
  KEY idx_fdb_moves (`device_id`, `last_move_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 106 — snmp_neighbors: LLDP as seen BY A SWITCH.
--
-- WHY THIS IS NOT `lldp_neighbors` (migration 063).
--
-- That table keys on `local_agent_id`, which is an `agents` id. An SNMP device
-- lives in `snmp_devices` (104) with its own id sequence, so writing a device id
-- into that column would collide with agent ids and silently attribute a
-- switch's neighbours to whichever agent happened to share the number. The
-- topology graph reads that table; a collision there does not throw, it just
-- draws the wrong network — the worst failure mode this product has.
--
-- So: a separate table with a foreign key to the right parent, and the merge
-- into the topology graph left as its own decision. That decision is genuinely
-- architectural — a switch sees far more neighbours than an agent host does,
-- including every access point and phone, and folding the two sources together
-- changes what the graph MEANS. It deserves its own change with its own
-- reasoning, not a column reused because it was nearby.
--
-- The data is collected and stored now so nothing is lost while that decision
-- waits, and `GET /api/snmp-devices/:id` serves it per device.
CREATE TABLE IF NOT EXISTS `snmp_neighbors` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  `local_port` INT UNSIGNED NULL DEFAULT NULL,
  `local_if_index` INT UNSIGNED NULL DEFAULT NULL,
  `local_if_name` VARCHAR(64) NULL DEFAULT NULL,
  `remote_chassis_id` VARCHAR(255) NOT NULL,
  `remote_port_id` VARCHAR(255) NULL DEFAULT NULL,
  `remote_port_desc` VARCHAR(255) NULL DEFAULT NULL,
  `remote_sys_name` VARCHAR(255) NULL DEFAULT NULL,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_snmp_neighbors` (`device_id`, `remote_chassis_id`, `remote_port_id`),
  KEY `idx_snmp_neighbors_device` (`device_id`, `last_seen`),
  KEY `idx_snmp_neighbors_remote` (`remote_chassis_id`),
  KEY `idx_snmp_neighbors_last_seen` (`last_seen`),
  CONSTRAINT `fk_snmp_neighbors_device` FOREIGN KEY (`device_id`) REFERENCES `snmp_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 107 — burst_runs: one-target, once-a-second measurement, on demand.
--
-- THE GAP THIS FILLS. Agents report on a 60-second interval and the analysis
-- baselines are hourly, so a five-second loss event is invisible. The fault a
-- technician is standing in front of, on the phone, right now, does not exist
-- in the data. A burst is not a new metric — it is a temporary resolution.
--
-- WHY THE SAMPLES ARE A JSON COLUMN AND NOT A TABLE.
--
-- A burst is at most 120 seconds at 2 Hz: 240 points, bounded, written once and
-- read as a whole. That is a small FIELD, not a time series. A row-per-sample
-- table would add a hot-path insert loop, a second retention dimension and a
-- join to every read, to store something that is never queried across runs,
-- never aggregated, and never grows after the run ends.
--
-- `probe_results` is the opposite case and stays as it is: unbounded, appended
-- forever, queried across time. The difference between the two is exactly why
-- this one is a column.
--
-- WHY THE VERDICT IS STORED. The analysis (median + MAD, and whether the losses
-- CLUSTER) is computed once, in code, from the samples — and kept, so the row
-- reads the same in a report six weeks later as it did on the screen. Same rule
-- every finding in this product follows: the explanation travels with the
-- measurement, and nothing re-derives a verdict from data that has since aged.
CREATE TABLE IF NOT EXISTS `burst_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `target` VARCHAR(255) NOT NULL,
  `probe` VARCHAR(16) NOT NULL DEFAULT 'ping',
  `requested_seconds` INT UNSIGNED NULL DEFAULT NULL,
  `seconds` INT UNSIGNED NOT NULL,
  `hz` DECIMAL(4, 2) NOT NULL DEFAULT 1.00,
  `started_at` DATETIME(3) NOT NULL,
  `ended_at` DATETIME(3) NULL DEFAULT NULL,
  `status` ENUM('running', 'complete', 'cancelled', 'failed') NOT NULL DEFAULT 'running',
  `error` VARCHAR(255) NULL DEFAULT NULL,
  `samples` JSON NULL DEFAULT NULL,
  `sample_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `lost_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `loss_pct` DECIMAL(5, 2) NULL DEFAULT NULL,
  `median_rtt_ms` DECIMAL(10, 3) NULL DEFAULT NULL,
  `p95_rtt_ms` DECIMAL(10, 3) NULL DEFAULT NULL,
  `jitter_ms` DECIMAL(10, 3) NULL DEFAULT NULL,
  `loss_clusters` INT UNSIGNED NULL DEFAULT NULL,
  `pattern` VARCHAR(32) NULL DEFAULT NULL,
  `explanation` VARCHAR(512) NULL DEFAULT NULL,
  `created_by` INT UNSIGNED NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_burst_runs_agent` (`agent_id`, `started_at`),
  KEY `idx_burst_runs_started` (`started_at`),
  CONSTRAINT `fk_burst_runs_user` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 108 — device_interfaces: the ports on a polled switch, as their own inventory.
--
-- WHY THIS IS NOT `interface_states` (mig. 088). That table keys on
-- (agent_id, iface) with ON DELETE CASCADE to `agents`: an interface there is a
-- NIC on a host we run on. A port on a switch is a different thing with a
-- different owner, and hanging it off an agent would mean deleting an agent
-- takes a switch's port history with it. Same call `snmp_neighbors` made
-- against `lldp_neighbors`, for the same reason: two id namespaces in one
-- column does not throw, it draws the wrong network.
--
-- WHY THE IDENTITY IS THE NAME AND NOT ifIndex.
--
-- ifIndex is only guaranteed stable between re-initialisations of the network
-- management system. A reboot may renumber; inserting a module into a chassis
-- almost always renumbers everything after it. Key a time series on ifIndex and
-- the 18th's numbers for Gi1/0/12 sit beside the 19th's for a Gi1/0/12 that is
-- now a different physical port — and nothing about the data says so.
--
-- So: UNIQUE (device_id, if_name). The name describes a physical position in
-- the chassis and survives both. `if_index` is a mutable ATTRIBUTE of the row,
-- and `if_index_changed_at` records when it last moved, because the poll that
-- notices the move is also the poll whose counter delta is meaningless.
--
-- `name_source` says WHICH oid the name came from. Not every switch implements
-- ifName; some only have ifDescr, which is less stable. Storing the fallback
-- that was used means a shaky identity is visible rather than assumed — the
-- same rule fdb_entries follows by keeping both the bridge port the device said
-- and the ifIndex it was resolved to.
--
-- This table is INVENTORY, not telemetry: one row per port, changed only when
-- somebody plugs in a module or renames a port. 20 switches x 48 ports is 960
-- rows. It stays in MySQL (docs/storage-split-audit.md); the counters that
-- reference it are the time series, and they are a separate story.
CREATE TABLE IF NOT EXISTS `device_interfaces` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  `if_name` VARCHAR(190) NOT NULL,
  `name_source` ENUM('ifName', 'ifDescr', 'ifIndex') NOT NULL DEFAULT 'ifName',
  `if_index` INT UNSIGNED NULL DEFAULT NULL,
  `if_index_changed_at` DATETIME NULL DEFAULT NULL,
  `if_alias` VARCHAR(255) NULL DEFAULT NULL,
  `if_descr` VARCHAR(255) NULL DEFAULT NULL,
  `if_type` INT UNSIGNED NULL DEFAULT NULL,
  `speed_mbps` INT UNSIGNED NULL DEFAULT NULL,
  `admin_status` VARCHAR(16) NULL DEFAULT NULL,
  `oper_status` VARCHAR(16) NULL DEFAULT NULL,
  `phys_address` CHAR(17) NULL DEFAULT NULL,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device_ifname` (`device_id`, `if_name`),
  KEY `idx_devif_device_index` (`device_id`, `if_index`),
  KEY `idx_devif_last_seen` (`last_seen`),
  CONSTRAINT `fk_devif_device` FOREIGN KEY (`device_id`) REFERENCES `snmp_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 109 — device_counter_samples: interface counters from a polled switch, over time.
--
-- This is the table the whole SNMP effort was building towards. Everything
-- before it answered WHERE something is; this answers what a port has been
-- DOING, and it is the first per-port time series in the product.
--
-- WHY BOTH THE RAW COUNTER AND THE COMPUTED RATE.
--
-- Nothing else here stores a raw counter: snmpMonitor.js reads twice and sends
-- rates, and the counters never leave the agent. That is fine when the agent
-- measures itself at a cadence it owns, and wrong here, because:
--
--   * A rate can never be recomputed. Change the definition of "utilisation"
--     and every historical number is stuck with the old one.
--   * A counter reset cannot be recognised after the fact. With only rates, a
--     reboot shows up as a single enormous spike that is indistinguishable from
--     a real one.
--   * A MISSING cycle cannot be told from a cycle that measured zero. A raw
--     counter that did not move says "no traffic"; a row that is not there says
--     "we did not look".
--
-- So the raw value is the evidence and the rate is the derivation, and both are
-- kept. `discontinuity` is what makes a NULL rate readable rather than
-- suspicious: the device rebooted, or its ifIndex moved, and the delta across
-- that boundary would have been a fabricated number.
--
-- WHY A WIDE ROW (one per port per poll) AND NOT ONE PER METRIC.
--
-- 20 switches x 48 ports x 10 metrics at 60 s is 13.8 million rows a day narrow
-- and 1.38 million wide — a factor of ten. The cost is that a new metric is an
-- ALTER rather than a new id, and with IF-MIB that is acceptable: the column set
-- is defined by an RFC from 2000 and does not move.
--
-- WHY interface_id AND NOT ifIndex.
--
-- ifIndex is only stable between re-initialisations of the network management
-- system. Keyed on it, the 18th's numbers for Gi1/0/12 would sit beside the
-- 19th's for a Gi1/0/12 that is now a different physical port. The samples point
-- at a `device_interfaces` row (migration 108), whose identity is the NAME, so a
-- renumbering moves one column in one inventory row and leaves every historical
-- measurement pointing at the right port.
--
-- STORE: TELEMETRY. This is the second-largest write stream in the product after
-- flow_records, and it belongs in TimescaleDB by the rules in
-- docs/storage-split-audit.md. It is dual-store like device_events and results:
-- MySQL is the fallback when TSDB is not configured, with a SHORTER retention,
-- because 180 bytes x 1.38 million rows a day is 10 GB a month in InnoDB.
--
-- NO FOREIGN KEY on interface_id, for the same reason results and device_events
-- have none: telemetry must not be deleted by a cascade from an inventory row,
-- and the TSDB copy cannot have one at all. The inventory is purged on a LONGER
-- window than these samples (180 days vs 90) so the reference stays resolvable.
CREATE TABLE IF NOT EXISTS `device_counter_samples` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ts` DATETIME(3) NOT NULL,
  `device_id` INT UNSIGNED NOT NULL,
  `interface_id` BIGINT UNSIGNED NOT NULL,
  `in_octets` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_octets` BIGINT UNSIGNED NULL DEFAULT NULL,
  `in_ucast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_ucast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `in_mcast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `in_bcast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_mcast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_bcast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `in_errors` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_errors` BIGINT UNSIGNED NULL DEFAULT NULL,
  `in_discards` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_discards` BIGINT UNSIGNED NULL DEFAULT NULL,
  `fcs_errors` BIGINT UNSIGNED NULL DEFAULT NULL,
  `alignment_errors` BIGINT UNSIGNED NULL DEFAULT NULL,
  `late_collisions` BIGINT UNSIGNED NULL DEFAULT NULL,
  `carrier_sense_errors` BIGINT UNSIGNED NULL DEFAULT NULL,
  `delta_sec` INT UNSIGNED NULL DEFAULT NULL,
  `in_bps` DOUBLE NULL DEFAULT NULL,
  `out_bps` DOUBLE NULL DEFAULT NULL,
  `in_err_pps` DOUBLE NULL DEFAULT NULL,
  `out_err_pps` DOUBLE NULL DEFAULT NULL,
  `in_disc_pps` DOUBLE NULL DEFAULT NULL,
  `out_disc_pps` DOUBLE NULL DEFAULT NULL,
  `fcs_pps` DOUBLE NULL DEFAULT NULL,
  `in_bcast_pps` DOUBLE NULL DEFAULT NULL,
  `in_util_pct` DOUBLE NULL DEFAULT NULL,
  `out_util_pct` DOUBLE NULL DEFAULT NULL,
  `discontinuity` ENUM('first', 'reboot', 'renumber', 'gap', 'wrap') NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_counter_sample` (`interface_id`, `ts`),
  KEY `idx_counter_device_ts` (`device_id`, `ts`),
  KEY `idx_counter_ts` (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 112 — SNMP credential profiles, and SNMPv3.
--
-- WHAT WAS PROPOSED, AND WHAT IS BUILT.
--
-- The proposal was: a profile per site, an optional profile per subnet, an
-- override per device, and the AGENT tries them in order, remembers what
-- worked and reports auth_failed per device.
--
-- The hierarchy is built. The ordered trying is NOT, and the reason is in
-- SNMP-AUDIT.md: trying credentials in sequence against an address is
-- credential spraying, and it is technically identical to an attack whatever
-- the intent.
--
--   * Against v3 it is actively harmful. v3 is authenticated, failed authPriv
--     attempts are logged as security events on most platforms and some lock
--     the account.
--   * Against v2c it produces silent failure. A wrong community usually gets
--     no error at all, just a timeout — three profiles x 30 s per device per
--     cycle, sequentially, against a 60 s interval floor. The polling collapses
--     before it finds anything.
--   * It is out of step with the rest of this feature, which checks the SSRF
--     deny-list TWICE for every device and keeps the community out of
--     SAFE_COLUMNS so a route cannot leak it by accident.
--
-- So the profile is resolved ON THE SERVER — device override, then the site
-- profile, then the global default — and the agent receives ONE credential per
-- device, exactly as it does today. The agent never learns that profiles exist,
-- which keeps the secret surface on the agent exactly the size it already is.
--
-- The subnet level is deliberately left out. `locations` already exists and is
-- what `snmp_devices.location_id` points at; a middle tier needing CIDR matching
-- on the server has to earn its place with a case that site + override cannot
-- express, and none was given.
CREATE TABLE IF NOT EXISTS `snmp_credential_profiles` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(190) NOT NULL,
  `is_global_default` TINYINT(1) NOT NULL DEFAULT 0,
  `version` ENUM('1', '2c', '3') NOT NULL DEFAULT '2c',
  `community_encrypted` TEXT NULL DEFAULT NULL,
  `v3_user` VARCHAR(190) NULL DEFAULT NULL,
  `v3_auth_proto` ENUM('md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512') NULL DEFAULT NULL,
  `v3_auth_key_encrypted` TEXT NULL DEFAULT NULL,
  `v3_priv_proto` ENUM('des', 'aes', 'aes256b', 'aes256r') NULL DEFAULT NULL,
  `v3_priv_key_encrypted` TEXT NULL DEFAULT NULL,
  `v3_context` VARCHAR(190) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_snmp_profile_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which communities are valid at a site. Many-to-many in both directions: a
-- site may have several (a core switch and an access stack under different
-- strings), and one community may serve twenty sites.
CREATE TABLE IF NOT EXISTS `snmp_profile_locations` (
  `profile_id` INT UNSIGNED NOT NULL,
  `location_id` INT UNSIGNED NOT NULL,
  `priority` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`profile_id`, `location_id`),
  KEY `idx_snmp_profile_loc_site` (`location_id`, `priority`, `profile_id`),
  CONSTRAINT `fk_snmp_profile_loc_profile` FOREIGN KEY (`profile_id`) REFERENCES `snmp_credential_profiles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_snmp_profile_loc_location` FOREIGN KEY (`location_id`) REFERENCES `locations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which communities an AGENT may walk with. This is the access rule, and it is
-- a grant rather than a filter: a row here is the only thing that lets an
-- agent be handed this community for any device it polls.
--
-- Deliberately NOT derived from the agent's own `location_id`. An agent moves
-- sites by an admin editing a dropdown, and a credential grant that follows a
-- dropdown is a credential grant nobody decided to make.
CREATE TABLE IF NOT EXISTS `snmp_profile_agents` (
  `profile_id` INT UNSIGNED NOT NULL,
  `agent_id` INT UNSIGNED NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`profile_id`, `agent_id`),
  KEY `idx_snmp_profile_agent_agent` (`agent_id`, `profile_id`),
  CONSTRAINT `fk_snmp_profile_agent_profile` FOREIGN KEY (`profile_id`) REFERENCES `snmp_credential_profiles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_snmp_profile_agent_agent` FOREIGN KEY (`agent_id`) REFERENCES `agents` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 115 — per-user acknowledgements on the Changes page.
--
-- The Changes feed owns no events: it is assembled on every request from a
-- dozen sources, and several of its rows (a silent agent, version skew) are
-- derived from current state and exist in no table at all. So an
-- acknowledgement cannot be written back to "the event" — for most rows there
-- is none. It is stored here instead, against the row's `ackKey`: a hash of the
-- CONDITION the row describes (see ackKeyFor in src/changes/changeFeed.js),
-- which is stable across reloads and windows.
--
-- PER USER, like the seen-marker in 074. Acknowledging a row hides it from the
-- caller's own view; it does not claim the problem for the team. The sources
-- that have a shared acknowledgement (findings, event clusters) keep theirs.
--
-- A NEW occurrence re-opens the row: the route compares the row's newest
-- timestamp with `acked_at`, so a condition that fires again after it was
-- acknowledged is shown again. DATETIME(3) because that comparison is against
-- millisecond timestamps — a whole-second column would round an acknowledgement
-- made at 12:00:00.400 down past a row stamped 12:00:00.300 half the time.
--
-- Bounded: the repository ignores and prunes rows older than 30 days, the
-- longest window the page can show.
CREATE TABLE IF NOT EXISTS `change_acks` (
  `user_id` INT UNSIGNED NOT NULL,
  `ack_key` CHAR(64) NOT NULL,
  `acked_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`user_id`, `ack_key`),
  KEY `idx_change_acks_user_time` (`user_id`, `acked_at`),
  CONSTRAINT `fk_change_acks_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 116 — per-user "Mute this rule" on the Changes page.
--
-- An acknowledgement (115) hides ONE row until its condition happens again. A
-- mute hides a whole KIND of row — every row of one source + type, on every
-- host — for a fixed time: "stop showing me version skew until tomorrow". The
-- key is the row's `muteKey` (muteKeyFor in src/changes/changeFeed.js).
--
-- PER USER, for the same reason as 115: the Changes feed owns no events, and
-- muting what one person sees must not change what the next shift sees. A mute
-- never touches alerting — rules that page people live in severity_rules and
-- alert_rules and are not affected.
--
-- TIME-BOXED, never permanent: a mute that outlives the reason for it is how a
-- landing page quietly stops showing the thing that matters. `muted_until` is
-- always set; the repository reads only live rows and prunes expired ones on
-- the next mute.
CREATE TABLE IF NOT EXISTS `change_mutes` (
  `user_id` INT UNSIGNED NOT NULL,
  `mute_key` CHAR(64) NOT NULL,
  `muted_until` DATETIME(3) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`, `mute_key`),
  KEY `idx_change_mutes_user_until` (`user_id`, `muted_until`),
  CONSTRAINT `fk_change_mutes_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
