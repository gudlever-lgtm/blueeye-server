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

-- Bookkeeping table used by the migration runner (src/migrate.js).
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  filename VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_schema_migrations_filename (filename)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 001 — create the locations table.
CREATE TABLE IF NOT EXISTS locations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  address VARCHAR(512) NULL DEFAULT NULL,
  latitude DECIMAL(9,6) NULL DEFAULT NULL,
  longitude DECIMAL(9,6) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 002 — create the users table (authentication + RBAC).
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  password_changed_at DATETIME NULL DEFAULT NULL,
  role ENUM('admin', 'operator', 'viewer') NOT NULL DEFAULT 'viewer',
  protected TINYINT(1) NOT NULL DEFAULT 0,
  preferences JSON DEFAULT NULL,
  last_seen_changes DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  tokens_valid_after DATETIME NULL DEFAULT NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  temp_password_expires_at DATETIME NULL DEFAULT NULL,
  temp_password_created_by INT UNSIGNED NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT fk_users_temp_pw_creator FOREIGN KEY (temp_password_created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 003 — create the agents table.
CREATE TABLE IF NOT EXISTS agents (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  hostname VARCHAR(255) NOT NULL,
  platform VARCHAR(64) NOT NULL,
  arch VARCHAR(32) NOT NULL,
  last_seen DATETIME NULL DEFAULT NULL,
  status ENUM('online', 'offline') NOT NULL DEFAULT 'offline',
  capabilities JSON NULL DEFAULT NULL,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  enrollment_code_id INT UNSIGNED NULL DEFAULT NULL,
  display_name VARCHAR(255) NULL DEFAULT NULL,
  notes TEXT NULL DEFAULT NULL,
  meta JSON NULL DEFAULT NULL,
  monitor_config JSON NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_agents_location_id (location_id),
  CONSTRAINT fk_agents_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL,
  KEY idx_agents_enrollment_code_id (enrollment_code_id),
  CONSTRAINT fk_agents_enrollment_code FOREIGN KEY (enrollment_code_id) REFERENCES enrollment_codes (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One-time codes used to enroll new agents. The `code` is random and unique;
-- it is returned to the operator once at creation.
CREATE TABLE IF NOT EXISTS enrollment_codes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  created_by INT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  max_uses INT UNSIGNED NOT NULL DEFAULT 1,
  uses_remaining INT UNSIGNED NOT NULL DEFAULT 1,
  used_at DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  code_hash CHAR(64) NULL DEFAULT NULL,
  code_enc TEXT NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_enrollment_codes_code (code),
  KEY idx_enrollment_codes_location_id (location_id),
  KEY idx_enrollment_codes_created_by (created_by),
  CONSTRAINT fk_enrollment_codes_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL,
  CONSTRAINT fk_enrollment_codes_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE,
  UNIQUE KEY uq_enrollment_codes_code_hash (code_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Opaque agent tokens. Only the SHA-256 hash is stored, never the token itself.
CREATE TABLE IF NOT EXISTS agent_tokens (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NULL DEFAULT NULL,
  token_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NULL DEFAULT NULL,
  revoked_at DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_tokens_token_hash (token_hash),
  KEY idx_agent_tokens_agent_id (agent_id),
  CONSTRAINT fk_agent_tokens_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 005 — test results reported by agents.
CREATE TABLE IF NOT EXISTS results (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  payload JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_results_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
  KEY idx_results_agent_created (agent_id, created_at),
  KEY idx_results_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 009 — analysis findings. Each row is a detected condition; explanation and
-- evidence are mandatory (enforced in the FindingStore before insert).
CREATE TABLE IF NOT EXISTS findings (
  id CHAR(36) NOT NULL,
  host_id VARCHAR(255) NOT NULL,
  metric VARCHAR(255) NOT NULL,
  severity ENUM('INFO', 'WARN', 'CRIT') NOT NULL,
  kind ENUM('ANOMALY', 'THRESHOLD', 'FLATLINE', 'CORRELATED') NOT NULL,
  observed DOUBLE NULL DEFAULT NULL,
  baseline DOUBLE NULL DEFAULT NULL,
  deviation DOUBLE NULL DEFAULT NULL,
  window_from DATETIME NULL DEFAULT NULL,
  window_to DATETIME NULL DEFAULT NULL,
  explanation TEXT NOT NULL,
  evidence JSON NOT NULL,
  correlated_with JSON NULL DEFAULT NULL,
  event_case_id BIGINT UNSIGNED NULL DEFAULT NULL,
  acked TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_findings_host_created (host_id, created_at),
  KEY idx_findings_created (created_at),
  KEY idx_findings_event_case (incident_case_id),
  CONSTRAINT fk_findings_event_case FOREIGN KEY (event_case_id) REFERENCES event_cases (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 010 — geo-enriched flow records. One row per reported flow. The external
-- (public) peer is geolocated to country + ASN; purely-internal flows (RFC1918
-- on both ends) are stored with internal=1 and are never geolocated.
CREATE TABLE IF NOT EXISTS flow_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  ts DATETIME NOT NULL,
  src_ip VARCHAR(45) NULL DEFAULT NULL,
  dst_ip VARCHAR(45) NULL DEFAULT NULL,
  ext_ip VARCHAR(45) NULL DEFAULT NULL,
  direction ENUM('in', 'out') NULL DEFAULT NULL,
  proto VARCHAR(16) NULL DEFAULT NULL,
  src_port INT NULL DEFAULT NULL,
  dst_port INT NULL DEFAULT NULL,
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  packets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  flows INT UNSIGNED NOT NULL DEFAULT 0,
  internal TINYINT(1) NOT NULL DEFAULT 0,
  country CHAR(2) NULL DEFAULT NULL,
  asn INT UNSIGNED NULL DEFAULT NULL,
  asn_name VARCHAR(255) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS flow_rollup (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bucket DATETIME NOT NULL,
  agent_id INT UNSIGNED NOT NULL,
  direction ENUM('in', 'out') NOT NULL DEFAULT 'out',
  country CHAR(2) NOT NULL DEFAULT '',
  asn INT UNSIGNED NOT NULL DEFAULT 0,
  asn_name VARCHAR(255) NULL DEFAULT NULL,
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  packets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  flow_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes_min BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes_max BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes_median DOUBLE NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_flow_rollup_bucket (agent_id, bucket, direction, country, asn),
  KEY idx_flow_rollup_bucket (bucket),
  KEY idx_flow_rollup_country (country, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 012 — down-sampled metric time-series. Raw metric samples (extracted from
-- result payloads) older than the raw-retention window are aggregated into time
-- buckets per (agent, metric), keeping min/max/median and a sample count. The
-- unique key makes re-runs idempotent (merge instead of duplicate).
CREATE TABLE IF NOT EXISTS metric_rollup (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bucket DATETIME NOT NULL,
  agent_id INT UNSIGNED NOT NULL,
  metric VARCHAR(64) NOT NULL,
  samples INT UNSIGNED NOT NULL DEFAULT 0,
  val_min DOUBLE NOT NULL DEFAULT 0,
  val_max DOUBLE NOT NULL DEFAULT 0,
  val_median DOUBLE NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_metric_rollup_bucket (agent_id, metric, bucket),
  KEY idx_metric_rollup_bucket (bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 013 — small key/value store for runtime-editable settings (e.g. map tiles).
-- Most configuration stays in env; this table holds the few values an admin can
-- change from the dashboard without a restart. Values are JSON.
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(64) NOT NULL,
  value JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 014 — active-probe results. The agent runs ping / TCP-connect / DNS /
-- traceroute probes (on operator command) and reports them here, giving
-- reachability + latency/loss/jitter over time for troubleshooting. Metadata
-- only: targets and timings, never payload.
CREATE TABLE IF NOT EXISTS probe_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  ts DATETIME NOT NULL,
  type VARCHAR(16) NOT NULL,
  target VARCHAR(255) NOT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  rtt_ms DOUBLE NULL DEFAULT NULL,
  min_ms DOUBLE NULL DEFAULT NULL,
  max_ms DOUBLE NULL DEFAULT NULL,
  jitter_ms DOUBLE NULL DEFAULT NULL,
  loss_pct DOUBLE NULL DEFAULT NULL,
  status SMALLINT NULL DEFAULT NULL,
  cert_expiry_days INT NULL DEFAULT NULL,
  bytes BIGINT NULL DEFAULT NULL,
  content_type VARCHAR(120) NULL DEFAULT NULL,
  elements JSON NULL DEFAULT NULL,
  hops JSON NULL DEFAULT NULL,
  detail VARCHAR(255) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS test_packages (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  schedule_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
  targets JSON NOT NULL,
  items JSON NOT NULL,
  created_by VARCHAR(255) NULL DEFAULT NULL,
  last_run_at DATETIME NULL DEFAULT NULL,
  last_run_summary JSON NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_test_packages_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 018 — active throughput ("speed test") results. The agent downloads then
-- uploads a sized blob to/from this server and reports the achieved rate in
-- Mbps. Self-contained (no external speed-test service). Metadata only: byte
-- counts and timings, never payload.
CREATE TABLE IF NOT EXISTS speedtest_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  ts DATETIME NOT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  down_mbps DOUBLE NULL DEFAULT NULL,
  up_mbps DOUBLE NULL DEFAULT NULL,
  down_bytes BIGINT UNSIGNED NULL DEFAULT NULL,
  up_bytes BIGINT UNSIGNED NULL DEFAULT NULL,
  down_ms DOUBLE NULL DEFAULT NULL,
  up_ms DOUBLE NULL DEFAULT NULL,
  target VARCHAR(255) NULL DEFAULT NULL,
  detail VARCHAR(255) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS agent_action_audit (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NULL DEFAULT NULL,
  agent_hostname VARCHAR(255) NULL DEFAULT NULL,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,
  actor_email VARCHAR(255) NULL DEFAULT NULL,
  actor_role VARCHAR(32) NULL DEFAULT NULL,
  action ENUM('upgrade', 'delete', 'install-tool') NOT NULL,
  target_version VARCHAR(64) NULL DEFAULT NULL,
  state ENUM('requested', 'completed', 'failed') NOT NULL DEFAULT 'requested',
  result_detail VARCHAR(512) NULL DEFAULT NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_audit_agent (agent_id, requested_at),
  KEY idx_audit_actor (actor_user_id, requested_at),
  CONSTRAINT fk_audit_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The sellable packages. `allowed_features` is a JSON array of feature keys;
-- NULL max_* means unlimited / configurable (Enterprise & MSP).
CREATE TABLE IF NOT EXISTS license_plans (
  plan_key VARCHAR(32) NOT NULL,
  plan_name VARCHAR(64) NOT NULL,
  max_agents INT UNSIGNED NULL DEFAULT NULL,
  max_test_paths INT UNSIGNED NULL DEFAULT NULL,
  history_days INT UNSIGNED NULL DEFAULT NULL,
  allowed_features JSON NULL,
  support_level VARCHAR(32) NOT NULL DEFAULT 'basic',
  is_trial TINYINT(1) NOT NULL DEFAULT 0,
  trial_days INT UNSIGNED NOT NULL DEFAULT 0,
  is_msp TINYINT(1) NOT NULL DEFAULT 0,
  is_enterprise TINYINT(1) NOT NULL DEFAULT 0,
  price_reference_eur INT UNSIGNED NULL DEFAULT NULL,
  price_reference_dkk INT UNSIGNED NULL DEFAULT NULL,
  price_from TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (plan_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The locally-stored license(s). For the current online-validation model these
-- mirror the signed proof; for the future offline model the signed_payload +
-- signature are the proof itself (verified by src/license/verify.js). The
-- *_override columns let a specific customer license raise/lower a plan default
-- without editing the plan. organization_id is reserved for the MSP model.
CREATE TABLE IF NOT EXISTS licenses (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NULL DEFAULT NULL,
  plan_key VARCHAR(32) NOT NULL,
  license_key VARCHAR(128) NULL DEFAULT NULL,
  license_status ENUM('active', 'trial', 'grace', 'expired', 'revoked', 'unlicensed')
    NOT NULL DEFAULT 'unlicensed',
  valid_from DATETIME NULL DEFAULT NULL,
  valid_until DATETIME NULL DEFAULT NULL,
  max_agents_override INT UNSIGNED NULL DEFAULT NULL,
  max_test_paths_override INT UNSIGNED NULL DEFAULT NULL,
  history_days_override INT UNSIGNED NULL DEFAULT NULL,
  support_level_override VARCHAR(32) NULL DEFAULT NULL,
  is_trial TINYINT(1) NOT NULL DEFAULT 0,
  signed_payload JSON NULL,
  signature VARCHAR(512) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS integrations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  type VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  base_url VARCHAR(512) NOT NULL,
  auth_type VARCHAR(32) NOT NULL DEFAULT 'none',
  credentials_encrypted TEXT NULL DEFAULT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  config_json JSON NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS integration_audit (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  integration_id INT UNSIGNED NULL DEFAULT NULL,
  integration_name VARCHAR(255) NULL DEFAULT NULL,
  integration_type VARCHAR(32) NULL DEFAULT NULL,
  event VARCHAR(64) NOT NULL,
  correlation_id VARCHAR(255) NULL DEFAULT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  status_code INT NULL DEFAULT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 1,
  detail VARCHAR(512) NULL DEFAULT NULL,
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,
  actor_email VARCHAR(255) NULL DEFAULT NULL,
  actor_role VARCHAR(32) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS ldap_config (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  host VARCHAR(255) NOT NULL,
  port INT UNSIGNED NOT NULL DEFAULT 389,
  use_tls TINYINT(1) NOT NULL DEFAULT 1,
  bind_dn VARCHAR(512) NULL DEFAULT NULL,
  bind_pw_encrypted TEXT NULL DEFAULT NULL,
  base_dn VARCHAR(512) NOT NULL,
  user_filter VARCHAR(512) NOT NULL DEFAULT '(sAMAccountName={{username}})',
  group_filter VARCHAR(512) NULL DEFAULT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Maps an LDAP/AD group DN to a BlueEyes role. On login the user's groups are
-- looked up and the HIGHEST matching role wins (admin > operator > viewer). NO
-- match means access is DENIED — there is deliberately no default role.
CREATE TABLE IF NOT EXISTS ldap_role_map (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ldap_group_dn VARCHAR(512) NOT NULL,
  blueeye_role ENUM('admin', 'operator', 'viewer') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ldap_role_map_group (ldap_group_dn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 029 — audit trail for LDAP/AD login attempts (success + failure). Records the
-- username, the outcome + reason, how many groups matched a role, the granted
-- role, and the source IP. Holds NO secrets — passwords are never written here.
-- Local JWT logins are unchanged; this only covers the external-auth path.
CREATE TABLE IF NOT EXISTS ldap_login_audit (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(255) NULL DEFAULT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  reason VARCHAR(64) NULL DEFAULT NULL,
  granted_role VARCHAR(32) NULL DEFAULT NULL,
  groups_matched INT UNSIGNED NOT NULL DEFAULT 0,
  source_ip VARCHAR(64) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS agent_release_key (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  singleton TINYINT UNSIGNED NOT NULL DEFAULT 1,
  public_pem TEXT NOT NULL,
  private_pem_encrypted TEXT NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  created_by INT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_release_key_singleton (singleton)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Risk register. risk_score is stored (likelihood * impact, both 1..5) so the API
-- never has to recompute it for filtering/sorting; the route guarantees it stays
-- consistent. management_acceptance records a documented risk-acceptance decision.
CREATE TABLE IF NOT EXISTS blueeye_nis2_risks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL DEFAULT NULL,
  category VARCHAR(64) NOT NULL,
  affected_asset VARCHAR(255) NULL DEFAULT NULL,
  likelihood TINYINT UNSIGNED NOT NULL DEFAULT 1,
  impact TINYINT UNSIGNED NOT NULL DEFAULT 1,
  risk_score SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  owner VARCHAR(255) NULL DEFAULT NULL,
  status ENUM('open', 'mitigating', 'accepted', 'closed') NOT NULL DEFAULT 'open',
  mitigation_plan TEXT NULL DEFAULT NULL,
  due_date DATE NULL DEFAULT NULL,
  management_acceptance TINYINT(1) NOT NULL DEFAULT 0,
  evidence_link VARCHAR(1024) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_nis2_risks_status (status),
  KEY idx_nis2_risks_category (category),
  KEY idx_nis2_risks_score (risk_score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Control evidence. A control is a recurring assurance activity tied to a NIS2
-- area. status reflects evidence health (OK / Partial / Missing / Overdue);
-- next_due drives the "overdue" highlighting on the dashboard.
CREATE TABLE IF NOT EXISTS blueeye_nis2_controls (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  control_name VARCHAR(255) NOT NULL,
  nis2_area VARCHAR(64) NOT NULL,
  description TEXT NULL DEFAULT NULL,
  owner VARCHAR(255) NULL DEFAULT NULL,
  frequency ENUM('daily', 'weekly', 'monthly', 'quarterly', 'annually', 'ad-hoc') NOT NULL DEFAULT 'quarterly',
  last_performed DATE NULL DEFAULT NULL,
  next_due DATE NULL DEFAULT NULL,
  evidence_file VARCHAR(1024) NULL DEFAULT NULL,
  status ENUM('OK', 'Partial', 'Missing', 'Overdue') NOT NULL DEFAULT 'Missing',
  comment TEXT NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_nis2_controls_area (nis2_area),
  KEY idx_nis2_controls_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Security incidents (NIS2 sense — distinct from the network `incidents` table,
-- which is derived from probes). incident_id is a human reference (INC-YYYY-NNNN)
-- generated by the repository. nis2_relevant / notification_required flag the
-- subset that may trigger a regulator notification obligation.
CREATE TABLE IF NOT EXISTS blueeye_nis2_incidents (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  incident_id VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  severity ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'medium',
  detected_at DATETIME NULL DEFAULT NULL,
  started_at DATETIME NULL DEFAULT NULL,
  resolved_at DATETIME NULL DEFAULT NULL,
  affected_systems TEXT NULL DEFAULT NULL,
  business_impact TEXT NULL DEFAULT NULL,
  root_cause TEXT NULL DEFAULT NULL,
  actions_taken TEXT NULL DEFAULT NULL,
  nis2_relevant TINYINT(1) NOT NULL DEFAULT 0,
  notification_required TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('open', 'investigating', 'contained', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  lessons_learned TEXT NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_nis2_incident_ref (incident_id),
  KEY idx_nis2_incidents_severity (severity),
  KEY idx_nis2_incidents_status (status),
  KEY idx_nis2_incidents_detected (detected_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Generated reports. snapshot_json freezes the headline metrics at generation
-- time so the NEXT report can show the delta ("development since last report").
-- A report is a draft until an admin/compliance approver accepts it.
CREATE TABLE IF NOT EXISTS blueeye_nis2_reports (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_type ENUM('readiness', 'executive', 'risk', 'control', 'incident') NOT NULL,
  title VARCHAR(255) NOT NULL,
  period_start DATE NULL DEFAULT NULL,
  period_end DATE NULL DEFAULT NULL,
  status ENUM('draft', 'approved') NOT NULL DEFAULT 'draft',
  summary TEXT NULL DEFAULT NULL,
  snapshot_json JSON NULL DEFAULT NULL,
  generated_by INT UNSIGNED NULL DEFAULT NULL,
  generated_by_email VARCHAR(255) NULL DEFAULT NULL,
  approved_by INT UNSIGNED NULL DEFAULT NULL,
  approved_by_email VARCHAR(255) NULL DEFAULT NULL,
  approved_at DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_nis2_reports_type (report_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Evidence references. A piece of evidence (document/link/screenshot) optionally
-- attached to a control, risk or report. Stored as a reference (file_url) rather
-- than a binary blob so the module needs no object store; the upload route
-- validates + sanitises the reference. Polymorphic link (entity_type/entity_id),
-- so it carries no FK.
CREATE TABLE IF NOT EXISTS blueeye_nis2_evidence (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL DEFAULT NULL,
  file_name VARCHAR(255) NULL DEFAULT NULL,
  file_url VARCHAR(1024) NULL DEFAULT NULL,
  content_type VARCHAR(128) NULL DEFAULT NULL,
  entity_type ENUM('control', 'risk', 'incident', 'report') NULL DEFAULT NULL,
  entity_id INT UNSIGNED NULL DEFAULT NULL,
  uploaded_by INT UNSIGNED NULL DEFAULT NULL,
  uploaded_by_email VARCHAR(255) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_nis2_evidence_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Generic audit log for the NIS2 module. One row per create/update/delete of a
-- risk, control or incident. old_value/new_value hold JSON snapshots so a change
-- is fully reconstructable. Actor identity is snapshotted (email) so the trail
-- survives user changes. No FK to users for the same reason.
CREATE TABLE IF NOT EXISTS blueeye_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NULL DEFAULT NULL,
  user_email VARCHAR(255) NULL DEFAULT NULL,
  action VARCHAR(32) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id INT UNSIGNED NULL DEFAULT NULL,
  old_value JSON NULL DEFAULT NULL,
  new_value JSON NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  category VARCHAR(32) NOT NULL,
  action VARCHAR(64) NOT NULL,
  outcome ENUM('success', 'failure', 'denied') NOT NULL DEFAULT 'success',
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,
  actor_email VARCHAR(255) NULL DEFAULT NULL,
  actor_role VARCHAR(32) NULL DEFAULT NULL,
  target VARCHAR(255) NULL DEFAULT NULL,
  detail VARCHAR(512) NULL DEFAULT NULL,
  ip VARCHAR(64) NULL DEFAULT NULL,
  prev_hash CHAR(64) NULL DEFAULT NULL,
  entry_hash CHAR(64) NULL DEFAULT NULL,
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
CREATE TABLE IF NOT EXISTS api_tokens (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  token_prefix VARCHAR(32) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  role ENUM('admin', 'operator', 'viewer') NOT NULL DEFAULT 'viewer',
  created_by_user_id INT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NULL DEFAULT NULL,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  revoked_at TIMESTAMP NULL DEFAULT NULL,
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
CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_type VARCHAR(16) NOT NULL,
  actor_id INT UNSIGNED NULL DEFAULT NULL,
  actor_label VARCHAR(255) NULL DEFAULT NULL,
  actor_role VARCHAR(32) NULL DEFAULT NULL,
  action VARCHAR(96) NOT NULL,
  target_type VARCHAR(64) NULL DEFAULT NULL,
  target_id VARCHAR(64) NULL DEFAULT NULL,
  target_label VARCHAR(255) NULL DEFAULT NULL,
  method VARCHAR(8) NULL DEFAULT NULL,
  path VARCHAR(255) NULL DEFAULT NULL,
  status INT NULL DEFAULT NULL,
  ip VARCHAR(64) NULL DEFAULT NULL,
  detail JSON NULL DEFAULT NULL,
  repeat_interval_ms INT UNSIGNED NULL DEFAULT NULL,
  occurrences INT UNSIGNED NOT NULL DEFAULT 1,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dedup_key VARCHAR(255) NULL DEFAULT NULL,
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
CREATE TABLE IF NOT EXISTS oidc_role_map (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  claim_value VARCHAR(512) NOT NULL,
  blueeye_role ENUM('admin', 'operator', 'viewer') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_oidc_role_map_claim (claim_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit trail for federated (OIDC/SAML) login attempts (success + failure).
-- Shared by both SSO flows; `provider` distinguishes them. Records the subject
-- (id-token sub / SAML NameID), the outcome + reason, how many groups matched a
-- role, the granted role and the source IP. Holds NO secrets — tokens and
-- assertions are never written here. Local + LDAP logins are unaffected.
CREATE TABLE IF NOT EXISTS sso_login_audit (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider VARCHAR(16) NOT NULL DEFAULT 'oidc',
  subject VARCHAR(255) NULL DEFAULT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  reason VARCHAR(64) NULL DEFAULT NULL,
  granted_role VARCHAR(32) NULL DEFAULT NULL,
  groups_matched INT UNSIGNED NOT NULL DEFAULT 0,
  source_ip VARCHAR(64) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sso_login_audit_provider (provider, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Maps a SAML attribute value (a group/role name from the configured role
-- attribute, default `groups`) to a BlueEyes role. On login the user's attribute
-- values are looked up and the HIGHEST matching role wins (admin > operator >
-- viewer). NO match means access is DENIED — there is deliberately no default
-- role. The column is named `claim_value` to share the generic role-map surface
-- with OIDC (oidc_role_map).
CREATE TABLE IF NOT EXISTS saml_role_map (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  claim_value VARCHAR(512) NOT NULL,
  blueeye_role ENUM('admin', 'operator', 'viewer') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_saml_role_map_claim (claim_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- 1. Password history + age ------------------------------------------------
-- Past password hashes, newest-first by id, so a change can refuse to reuse the
-- last N. Hashes only (bcrypt) — never plaintext. Dropped with the user.
CREATE TABLE IF NOT EXISTS password_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_password_history_user (user_id, id),
  CONSTRAINT fk_password_history_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lokationsdrevet investigation-resultater. Gemmer output fra
-- runInvestigation() inkl. klassifikation, beviser og eventuel AI-narrativ.
CREATE TABLE IF NOT EXISTS investigations (
  id CHAR(36)      NOT NULL,
  location_ref JSON          NOT NULL,
  window_from DATETIME      NOT NULL,
  window_to DATETIME      NOT NULL,
  classification ENUM('LOCAL','UPSTREAM','DOWNSTREAM','APP_NOT_NET','INSUFFICIENT_DATA') NOT NULL,
  confidence DECIMAL(4,3)  NOT NULL DEFAULT 0,
  explanation TEXT          NOT NULL,
  evidence JSON          NOT NULL,
  suspected_segment JSON        NULL,
  related_finding_ids JSON      NOT NULL DEFAULT ('[]'),
  workaround_hints JSON      NOT NULL DEFAULT ('[]'),
  narrative TEXT          NULL,
  created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_investigations_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS transaction_tests (
  id INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type ENUM('http','tcp','dns','icmp') NOT NULL,
  target VARCHAR(255)     DEFAULT NULL,
  config JSON         NOT NULL,
  config_secrets JSON             DEFAULT NULL,
  interval_sec INT          NOT NULL DEFAULT 60,
  enabled TINYINT(1)   NOT NULL DEFAULT 1,
  created_by INT              DEFAULT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Assignment join. PK on (test_id, agent_id). No FKs (kept lean; the app deletes
-- assignments explicitly on test/agent removal).
CREATE TABLE IF NOT EXISTS transaction_test_agents (
  test_id INT NOT NULL,
  agent_id INT NOT NULL,
  PRIMARY KEY (test_id, agent_id),
  INDEX idx_txa_agent (agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One result per (agent, test, run). step_timings carries per-step ms; detail is
-- structured JSON-in-string {phase,step,errno} for failures. NO foreign keys —
-- this table is destined for TimescaleDB.
CREATE TABLE IF NOT EXISTS transaction_results (
  time DATETIME(3) NOT NULL,
  test_id INT         NOT NULL,
  agent_id INT         NOT NULL,
  status ENUM('ok','fail','timeout','error') NOT NULL,
  latency_ms INT             DEFAULT NULL,
  step_timings JSON           DEFAULT NULL,
  step_failed TINYINT         DEFAULT NULL,
  deviation ENUM('normal','slower','faster') DEFAULT NULL,
  detail VARCHAR(255)    DEFAULT NULL,
  INDEX idx_txr_test_agent_time (test_id, agent_id, time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Robust baseline per (test, agent, step): median + MAD over the last 7 days of
-- ok results, recomputed hourly by the baseline job. step 0 = whole-test latency;
-- steps 1..N = per-step timings (http). PK on (test, agent, step).
CREATE TABLE IF NOT EXISTS transaction_baselines (
  test_id INT     NOT NULL,
  agent_id INT     NOT NULL,
  step TINYINT NOT NULL,
  median_ms INT     NOT NULL,
  mad_ms INT     NOT NULL,
  sample_count INT     NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS config_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id INT UNSIGNED NOT NULL,
  config_text MEDIUMTEXT NOT NULL,
  captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  captured_via ENUM('manual', 'agent_poll', 'change_detected') NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS cmdb_config (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  type ENUM('servicenow', 'nautobot', 'custom') NOT NULL,
  base_url VARCHAR(512) NOT NULL,
  auth_type VARCHAR(32) NOT NULL DEFAULT 'none',
  config_json JSON NULL DEFAULT NULL,
  credentials_encrypted TEXT NULL DEFAULT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  verified_at DATETIME NULL DEFAULT NULL,
  updated_by INT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_cmdb_links (
  agent_id INT UNSIGNED NOT NULL,
  cmdb_asset_id VARCHAR(255) NOT NULL,
  cmdb_asset_name VARCHAR(255) NOT NULL,
  cmdb_asset_location VARCHAR(255) NULL DEFAULT NULL,
  linked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  linked_by INT UNSIGNED NULL DEFAULT NULL,
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
CREATE TABLE IF NOT EXISTS remediation_playbooks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(200) NOT NULL,
  trigger_condition VARCHAR(120) NOT NULL,
  action_type VARCHAR(60) NOT NULL,
  auto_trigger TINYINT(1) NOT NULL DEFAULT 0,
  manual_action_text TEXT NULL DEFAULT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS alert_dispatch_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subject_type ENUM('finding', 'cluster') NOT NULL,
  subject_id VARCHAR(64) NOT NULL,
  host_id VARCHAR(64) NULL DEFAULT NULL,
  metric VARCHAR(120) NULL DEFAULT NULL,
  severity VARCHAR(16) NULL DEFAULT NULL,
  channels VARCHAR(255) NULL DEFAULT NULL,
  sent_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS runbooks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  finding_type VARCHAR(120) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body_markdown MEDIUMTEXT NOT NULL,
  linked_playbook_id INT UNSIGNED NULL DEFAULT NULL,
  updated_by INT UNSIGNED NULL DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS verification_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cluster_id BIGINT UNSIGNED NOT NULL,
  playbook_id INT UNSIGNED NULL DEFAULT NULL,
  runbook_id INT UNSIGNED NULL DEFAULT NULL,
  triggered_by VARCHAR(190) NULL DEFAULT NULL,
  affected_targets JSON NOT NULL,
  finding_types JSON NOT NULL,
  settle_seconds INT UNSIGNED NOT NULL,
  executed_at DATETIME NOT NULL,
  due_at DATETIME NOT NULL,
  status ENUM('pending', 'passed', 'failed', 'error') NOT NULL DEFAULT 'pending',
  readings JSON NULL DEFAULT NULL,
  completed_at DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS lldp_neighbors (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  local_agent_id INT UNSIGNED NOT NULL,
  local_chassis_id VARCHAR(190) NULL DEFAULT NULL,
  local_port VARCHAR(190) NULL DEFAULT NULL,
  remote_chassis_id VARCHAR(190) NOT NULL,
  remote_port VARCHAR(190) NULL DEFAULT NULL,
  link_state VARCHAR(16) NULL DEFAULT NULL,
  last_seen DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS cluster_evidence_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cluster_id BIGINT UNSIGNED NOT NULL,
  target VARCHAR(64) NOT NULL,
  command_set_version VARCHAR(32) NOT NULL,
  status ENUM('pending', 'complete', 'partial', 'failed', 'agent-offline') NOT NULL DEFAULT 'pending',
  items JSON NOT NULL,
  payload_gzip MEDIUMBLOB NULL DEFAULT NULL,
  payload_bytes INT UNSIGNED NOT NULL DEFAULT 0,
  captured_at DATETIME NOT NULL,
  trigger VARCHAR(16) NOT NULL DEFAULT 'auto',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS service_dependencies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  src_host_id INT UNSIGNED NOT NULL,
  dst_host_id INT UNSIGNED NOT NULL,
  dst_port INT UNSIGNED NOT NULL,
  proto VARCHAR(16) NOT NULL DEFAULT 'tcp',
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  packets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  conn_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_dep_edge (src_host_id, dst_host_id, dst_port),
  KEY idx_service_dep_src (src_host_id, bytes),
  KEY idx_service_dep_dst (dst_host_id, bytes),
  KEY idx_service_dep_last_seen (last_seen),
  CONSTRAINT fk_service_dep_src FOREIGN KEY (src_host_id) REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_service_dep_dst FOREIGN KEY (dst_host_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS topology_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  change_type ENUM('neighbour_added','neighbour_removed','link_state_changed','port_moved','flapping') NOT NULL,
  local_port VARCHAR(190) NULL DEFAULT NULL,
  remote_chassis_id VARCHAR(190) NULL DEFAULT NULL,
  remote_port VARCHAR(190) NULL DEFAULT NULL,
  from_local_port VARCHAR(190) NULL DEFAULT NULL,
  link_state_from VARCHAR(16) NULL DEFAULT NULL,
  link_state_to VARCHAR(16) NULL DEFAULT NULL,
  severity ENUM('INFO','WARN','CRIT') NOT NULL DEFAULT 'INFO',
  summary VARCHAR(512) NOT NULL,
  detected_at DATETIME(3) NOT NULL,
  audit_log_id BIGINT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS flow_pair_hourly (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bucket DATETIME NOT NULL,
  src_host_id INT UNSIGNED NOT NULL,
  dst_host_id INT UNSIGNED NOT NULL,
  dst_port INT UNSIGNED NOT NULL,
  proto VARCHAR(16) NOT NULL DEFAULT 'tcp',
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  packets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  conn_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_flow_pair_hourly (bucket, src_host_id, dst_host_id, dst_port),
  KEY idx_flow_pair_hourly_tuple (src_host_id, dst_host_id, dst_port, bucket),
  KEY idx_flow_pair_hourly_bucket (bucket),
  CONSTRAINT fk_flow_pair_hourly_src FOREIGN KEY (src_host_id) REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_flow_pair_hourly_dst FOREIGN KEY (dst_host_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_pair_baselines (
  src_host_id INT UNSIGNED NOT NULL,
  dst_host_id INT UNSIGNED NOT NULL,
  dst_port INT UNSIGNED NOT NULL,
  dow TINYINT UNSIGNED NOT NULL,
  hour TINYINT UNSIGNED NOT NULL,
  median_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  mad_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  sample_count INT UNSIGNED NOT NULL DEFAULT 0,
  observation_count INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS discovered_devices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ip VARCHAR(45) NOT NULL,
  hostname VARCHAR(255) NULL DEFAULT NULL,
  open_ports VARCHAR(255) NULL DEFAULT NULL,
  icmp TINYINT(1) NOT NULL DEFAULT 0,
  found_by_agent_id INT UNSIGNED NULL DEFAULT NULL,
  status ENUM('discovered','promoted','ignored') NOT NULL DEFAULT 'discovered',
  promoted_agent_id INT UNSIGNED NULL DEFAULT NULL,
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS host_connections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  src_ip VARCHAR(64) NOT NULL,
  dst_ip VARCHAR(64) NOT NULL,
  dst_port INT UNSIGNED NOT NULL,
  conn_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_seen DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS arp_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  ip VARCHAR(45) NOT NULL,
  mac CHAR(17) NOT NULL,
  interface VARCHAR(64) NULL DEFAULT NULL,
  source ENUM('evidence', 'capabilities') NOT NULL DEFAULT 'capabilities',
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  mac_changed_at DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS interface_states (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  iface VARCHAR(190) NOT NULL,
  status VARCHAR(16) NOT NULL,
  oper_status VARCHAR(32) NULL DEFAULT NULL,
  virtual TINYINT(1) NOT NULL DEFAULT 0,
  first_seen DATETIME(3) NOT NULL,
  last_seen DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_iface_state (agent_id, iface),
  KEY idx_iface_state_last_seen (last_seen),
  CONSTRAINT fk_iface_state_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interface_state_transitions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  iface VARCHAR(190) NOT NULL,
  from_status VARCHAR(16) NULL DEFAULT NULL,
  to_status VARCHAR(16) NOT NULL,
  oper_status VARCHAR(32) NULL DEFAULT NULL,
  severity ENUM('INFO', 'WARN', 'CRIT') NOT NULL DEFAULT 'INFO',
  summary VARCHAR(512) NOT NULL,
  flap_count INT UNSIGNED NOT NULL DEFAULT 1,
  flapping TINYINT(1) NOT NULL DEFAULT 0,
  detected_at DATETIME(3) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS event_cases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  host_id VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status ENUM('open', 'investigating', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  severity ENUM('INFO', 'WARN', 'CRIT') NOT NULL DEFAULT 'INFO',
  primary_finding_id CHAR(36) NULL DEFAULT NULL,
  config_change_id BIGINT UNSIGNED NULL DEFAULT NULL,
  first_event_at DATETIME NOT NULL,
  last_event_at DATETIME NOT NULL,
  resolved_at DATETIME NULL DEFAULT NULL,
  created_by ENUM('system', 'manual') NOT NULL DEFAULT 'system',
  closed_by INT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_event_cases_host_status (host_id, status),
  KEY idx_event_cases_status (status),
  KEY idx_event_cases_last_event (last_event_at),
  KEY idx_event_cases_config_change (config_change_id),
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
CREATE TABLE IF NOT EXISTS event_notes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_case_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('observation', 'action', 'ruled_out') NOT NULL,
  text VARCHAR(4000) NOT NULL,
  author_user_id INT UNSIGNED NULL DEFAULT NULL,
  author_email VARCHAR(255) NULL DEFAULT NULL,
  author_role VARCHAR(32) NULL DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_event_notes_case (incident_case_id, created_at),
  KEY idx_event_notes_ruled_out (incident_case_id, kind, created_at),
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
CREATE TABLE IF NOT EXISTS event_clusters (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  confidence ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'low',
  member_finding_ids JSON NOT NULL,
  suspected_common_cause TEXT NULL DEFAULT NULL,
  advisory TEXT NULL DEFAULT NULL,
  alert_last_at DATETIME NULL DEFAULT NULL,
  alert_last_severity VARCHAR(16) NULL DEFAULT NULL,
  alert_member_count INT UNSIGNED NULL DEFAULT NULL,
  itsm_ticket_ref VARCHAR(190) NULL DEFAULT NULL,
  itsm_integration_id INT UNSIGNED NULL DEFAULT NULL,
  nis2_draft_id BIGINT UNSIGNED NULL DEFAULT NULL,
  status ENUM('open', 'acknowledged', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  detected_at DATETIME NOT NULL,
  acknowledged_at DATETIME NULL DEFAULT NULL,
  acknowledged_by INT UNSIGNED NULL DEFAULT NULL,
  resolved_at DATETIME NULL DEFAULT NULL,
  resolved_by INT UNSIGNED NULL DEFAULT NULL,
  resolution_note TEXT NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_event_clusters_status_detected (status, detected_at),
  CONSTRAINT fk_event_clusters_ack_by FOREIGN KEY (acknowledged_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_event_clusters_resolved_by FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_playbook_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_case_id BIGINT UNSIGNED NOT NULL,
  playbook_id INT UNSIGNED NOT NULL,
  status ENUM('pending', 'succeeded', 'failed') NOT NULL DEFAULT 'pending',
  result_text TEXT NULL DEFAULT NULL,
  ran_by VARCHAR(120) NULL DEFAULT NULL,
  ran_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_event_playbook_runs_event (incident_case_id, ran_at),
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
CREATE TABLE IF NOT EXISTS probe_outages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  agent_id INT UNSIGNED NOT NULL,
  metric ENUM('reachability', 'latency', 'packet_loss') NOT NULL,
  severity ENUM('warning', 'critical') NOT NULL,
  started_at DATETIME NOT NULL,
  resolved_at DATETIME NULL DEFAULT NULL,
  duration_seconds INT UNSIGNED NULL DEFAULT NULL,
  affected_target VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE TABLE IF NOT EXISTS probe_thresholds (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  metric ENUM('reachability', 'latency', 'packet_loss') NOT NULL,
  warning_value DOUBLE NULL DEFAULT NULL,
  critical_value DOUBLE NULL DEFAULT NULL,
  debounce_count INT UNSIGNED NOT NULL DEFAULT 3,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_probe_thresholds_location_metric (location_id, metric),
  CONSTRAINT fk_probe_thresholds_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
