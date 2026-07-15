-- BlueEye server — canonical database schema (full snapshot).
--
-- Two ways to set up a database:
--   1) Run the migration runner (recommended):   npm run migrate
--      It applies the ordered files in migrations/ and records them in
--      schema_migrations, so it is safe to re-run.
--   2) Load this snapshot directly into a fresh DB:
--        mysql -u <user> -p <database> < schema.sql
--
-- migrations/ is the source of truth for incremental changes; this file is
-- kept in sync as a convenient full picture of the current schema. Column
-- additions / indexes from later migrations are folded into the CREATE TABLE
-- definitions below, so loading this once yields the same schema as migrate.

SET NAMES utf8mb4;

-- Bookkeeping table used by the migration runner (src/migrate.js).
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  filename VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_schema_migrations_filename (filename)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Physical sites / offices, e.g. "Aarhus – Hovedkontor".
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

-- Application users for authentication + RBAC.
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'operator', 'viewer') NOT NULL DEFAULT 'viewer',
  protected TINYINT(1) NOT NULL DEFAULT 0,
  preferences JSON DEFAULT NULL,
  -- JWTs issued before this instant are rejected (set on password/role change,
  -- delete, or explicit revoke). NULL = never revoked. See src/auth/revocation.
  tokens_valid_after DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Managed endpoints/agents. Agent-reported fields (hostname, platform, arch,
-- last_seen, status) are kept distinct from server-managed fields
-- (location_id, display_name, notes, meta). Agents are created via enrollment.
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
  KEY idx_agents_enrollment_code_id (enrollment_code_id),
  CONSTRAINT fk_agents_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One-time / bulk codes used to enroll new agents. A code may be redeemed up to
-- max_uses times within its TTL (default 1 = single-use); uses_remaining is
-- decremented on each enrollment, used_at is set when fully consumed.
CREATE TABLE IF NOT EXISTS enrollment_codes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  created_by INT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  max_uses INT UNSIGNED NOT NULL DEFAULT 1,
  uses_remaining INT UNSIGNED NOT NULL DEFAULT 1,
  used_at DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_enrollment_codes_code (code),
  KEY idx_enrollment_codes_location_id (location_id),
  KEY idx_enrollment_codes_created_by (created_by),
  CONSTRAINT fk_enrollment_codes_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE SET NULL,
  CONSTRAINT fk_enrollment_codes_created_by FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- agents.enrollment_code_id links an agent to the code it enrolled with. Added
-- here (after enrollment_codes exists) because agents is created first above.
-- ON DELETE SET NULL so deleting a spent code never breaks a running agent.
ALTER TABLE agents
  ADD CONSTRAINT fk_agents_enrollment_code FOREIGN KEY (enrollment_code_id)
    REFERENCES enrollment_codes (id) ON DELETE SET NULL;

-- Opaque agent tokens; only the SHA-256 hash is stored, never the token.
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
  CONSTRAINT fk_agent_tokens_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Test results reported by agents (via REST, agent-token authenticated).
CREATE TABLE IF NOT EXISTS results (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  payload JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_results_agent_created (agent_id, created_at),
  KEY idx_results_created (created_at),
  CONSTRAINT fk_results_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Analysis findings. Each row is a detected condition; explanation and evidence
-- are mandatory (enforced in the FindingStore before insert).
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
  acked TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_findings_host_created (host_id, created_at),
  KEY idx_findings_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Geo-enriched flow records. One row per reported flow. The external (public)
-- peer is geolocated to country + ASN; purely-internal flows (RFC1918 on both
-- ends) are stored with internal=1 and are never geolocated.
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
  CONSTRAINT fk_flows_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Down-sampled flow records. Raw flow_records older than the raw-retention
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

-- Down-sampled metric time-series. Raw metric samples (extracted from result
-- payloads) older than the raw-retention window are aggregated into time buckets
-- per (agent, metric), keeping min/max/median and a sample count. The unique key
-- makes re-runs idempotent (merge instead of duplicate).
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

-- Small key/value store for runtime-editable settings (e.g. map tiles). Most
-- configuration stays in env; this table holds the few values an admin can
-- change from the dashboard without a restart. Values are JSON.
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(64) NOT NULL,
  value JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Active-probe results (ping / TCP-connect / DNS / traceroute / http). Gives
-- reachability + latency/loss/jitter over time for troubleshooting. status +
-- cert_expiry_days back the http(s) probe (migration 019); a plain ts index
-- (migration 015) serves the fleet-wide scan. Metadata only, never payload.
CREATE TABLE IF NOT EXISTS probe_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  ts DATETIME NOT NULL,
  type VARCHAR(16) NOT NULL,          -- ping | tcp | dns | traceroute | http
  target VARCHAR(255) NOT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  rtt_ms DOUBLE NULL DEFAULT NULL,    -- average round-trip time
  min_ms DOUBLE NULL DEFAULT NULL,
  max_ms DOUBLE NULL DEFAULT NULL,
  jitter_ms DOUBLE NULL DEFAULT NULL,
  loss_pct DOUBLE NULL DEFAULT NULL,
  status SMALLINT NULL DEFAULT NULL,            -- http: final HTTP status code
  cert_expiry_days INT NULL DEFAULT NULL,       -- https: TLS cert days-to-expiry
  hops JSON NULL DEFAULT NULL,        -- traceroute path [{hop,ip,rttMs}]
  detail VARCHAR(255) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_probe_agent_ts (agent_id, ts),
  KEY idx_probe_agent_type_ts (agent_id, type, ts),
  KEY idx_probe_agent_type_target_id (agent_id, type, target, id),
  KEY idx_probe_ts (ts),
  CONSTRAINT fk_probe_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Server-defined "test packages": a named set of probe/traffic tests the server
-- pushes to selected agents (all / specific / by location) to run, on a schedule
-- or on demand. Agents execute via the existing run-probe / run-test commands.
CREATE TABLE IF NOT EXISTS test_packages (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  schedule_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,   -- 0 = manual only (no schedule)
  targets JSON NOT NULL,                            -- {mode:'all'|'agents'|'location', agentIds:[], locationIds:[]}
  items JSON NOT NULL,                              -- [{type:'probe', probe:{...}} | {type:'run-test', intervalMs?}]
  created_by VARCHAR(255) NULL DEFAULT NULL,
  last_run_at DATETIME NULL DEFAULT NULL,
  last_run_summary JSON NULL DEFAULT NULL,          -- {at, targeted, reached, delivered, items}
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_test_packages_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Active throughput ("speed test") results. The agent downloads then uploads a
-- sized blob to/from this server and reports the achieved rate in Mbps.
-- Self-contained. Metadata only: byte counts and timings, never payload.
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
  CONSTRAINT fk_speedtest_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Persistent audit trail for server-initiated agent actions (upgrade / delete).
-- One row per action, carrying two states on the same record: 'requested' then
-- 'completed'/'failed' when the agent reports back. Agent identity is snapshotted
-- (hostname/location) so the trail survives the agent being deleted. Holds NO
-- secrets — tokens/signatures are never written here.
CREATE TABLE IF NOT EXISTS agent_action_audit (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NULL DEFAULT NULL,
  agent_hostname VARCHAR(255) NULL DEFAULT NULL,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,
  actor_email VARCHAR(255) NULL DEFAULT NULL,
  actor_role VARCHAR(32) NULL DEFAULT NULL,
  action ENUM('upgrade', 'delete') NOT NULL,
  target_version VARCHAR(64) NULL DEFAULT NULL,
  state ENUM('requested', 'completed', 'failed') NOT NULL DEFAULT 'requested',
  result_detail VARCHAR(512) NULL DEFAULT NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_audit_agent (agent_id, requested_at),
  KEY idx_audit_actor (actor_user_id, requested_at),
  CONSTRAINT fk_audit_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- License plans (the sellable packages) + locally-stored licenses. The CODE's
-- source of truth for plan capabilities is src/license/plans.js; these tables
-- mirror that catalogue for the admin UI / reporting and hold the structure the
-- offline signed-license model populates. Seeded below (idempotent).
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
  CONSTRAINT fk_license_plan FOREIGN KEY (plan_key)
    REFERENCES license_plans (plan_key) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed / refresh the catalogue. Must stay in sync with src/license/plans.js.
INSERT INTO license_plans
  (plan_key, plan_name, max_agents, max_test_paths, history_days, allowed_features,
   support_level, is_trial, trial_days, is_msp, is_enterprise,
   price_reference_eur, price_reference_dkk, price_from)
VALUES
  ('pilot', 'Pilot', 5, 10, 60,
   JSON_ARRAY('dashboard_basic', 'reports_basic'),
   'basic', 1, 60, 0, 0, 2500, 18500, 0),
  ('starter', 'Starter', 5, 25, 90,
   JSON_ARRAY('dashboard_basic', 'reports_basic'),
   'basic', 0, 0, 0, 0, 4000, 30000, 0),
  ('professional', 'Professional', 25, 150, 365,
   JSON_ARRAY('dashboard_basic', 'dashboard_advanced', 'reports_basic', 'reports_pdf',
              'reports_csv', 'reports_sla', 'reports_compliance', 'rbac', 'audit_log',
              'api_access', 'alerts_email', 'alerts_webhook', 'sso_ldap', 'sso_oidc',
              'sso_saml', 'premium_support'),
   'premium', 0, 0, 0, 0, 12000, 90000, 0)
ON DUPLICATE KEY UPDATE
  plan_name = VALUES(plan_name),
  max_agents = VALUES(max_agents),
  max_test_paths = VALUES(max_test_paths),
  history_days = VALUES(history_days),
  allowed_features = VALUES(allowed_features),
  support_level = VALUES(support_level),
  is_trial = VALUES(is_trial),
  trial_days = VALUES(trial_days),
  is_msp = VALUES(is_msp),
  is_enterprise = VALUES(is_enterprise),
  price_reference_eur = VALUES(price_reference_eur),
  price_reference_dkk = VALUES(price_reference_dkk),
  price_from = VALUES(price_from);

-- Per-metric thresholds used to derive incidents from active-probe results.
-- location_id IS NULL = global default; a concrete location_id overrides it.
CREATE TABLE IF NOT EXISTS incident_thresholds (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  metric ENUM('reachability', 'latency', 'packet_loss') NOT NULL,
  warning_value DOUBLE NULL DEFAULT NULL,
  critical_value DOUBLE NULL DEFAULT NULL,
  debounce_count INT UNSIGNED NOT NULL DEFAULT 3,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_incident_thresholds_location_metric (location_id, metric),
  CONSTRAINT fk_incident_thresholds_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Incidents derived from probe_results (one per (agent, metric, target) outage).
-- started_at = first failing result in the breaching sequence; resolved_at NULL
-- while active. At most one active incident per (agent, metric, target).
CREATE TABLE IF NOT EXISTS incidents (
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
  KEY idx_incidents_location_started (location_id, started_at),
  KEY idx_incidents_resolved (resolved_at),
  KEY idx_incidents_active (agent_id, metric, affected_target, resolved_at),
  CONSTRAINT fk_incidents_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_incidents_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Outbound API integrations (ITSM/IPAM connectors). One row per configured
-- target system. Credentials are ENCRYPTED at rest (AES-256-GCM via
-- src/lib/secretBox.js) in credentials_encrypted — never plaintext.
CREATE TABLE IF NOT EXISTS integrations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  type VARCHAR(32) NOT NULL,                       -- 'servicenow' | 'nautobot' | 'webhook' | (future)
  name VARCHAR(255) NOT NULL,
  base_url VARCHAR(512) NOT NULL,
  auth_type VARCHAR(32) NOT NULL DEFAULT 'none',   -- 'basic' | 'oauth2' | 'token' | 'none'
  credentials_encrypted TEXT NULL DEFAULT NULL,    -- secretBox token; never plaintext
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  config_json JSON NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_integrations_name (name),
  KEY idx_integrations_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit trail for outbound integration calls. One row per fire (event or manual
-- test). The integration name + type are snapshotted so the trail survives the
-- integration being deleted. Holds NO secrets.
CREATE TABLE IF NOT EXISTS integration_audit (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  integration_id INT UNSIGNED NULL DEFAULT NULL,
  integration_name VARCHAR(255) NULL DEFAULT NULL,
  integration_type VARCHAR(32) NULL DEFAULT NULL,
  event VARCHAR(64) NOT NULL,                  -- 'incident' | 'anomaly' | 'agent.enroll' | 'agent.delete' | 'test'
  correlation_id VARCHAR(255) NULL DEFAULT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  status_code INT NULL DEFAULT NULL,           -- HTTP status from the target (NULL on a network failure)
  attempts INT UNSIGNED NOT NULL DEFAULT 1,
  detail VARCHAR(512) NULL DEFAULT NULL,
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,
  actor_email VARCHAR(255) NULL DEFAULT NULL,
  actor_role VARCHAR(32) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_integration_audit_integration (integration_id, created_at),
  KEY idx_integration_audit_event (event, created_at),
  CONSTRAINT fk_integration_audit_integration FOREIGN KEY (integration_id)
    REFERENCES integrations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- External auth via LDAP/AD (supplements local JWT login). A single-row
-- connection config + a group-to-role map. The bind password is ENCRYPTED at
-- rest (AES-256-GCM via src/lib/secretBox.js) in bind_pw_encrypted.
CREATE TABLE IF NOT EXISTS ldap_config (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  host VARCHAR(255) NOT NULL,
  port INT UNSIGNED NOT NULL DEFAULT 389,
  use_tls TINYINT(1) NOT NULL DEFAULT 1,
  bind_dn VARCHAR(512) NULL DEFAULT NULL,
  bind_pw_encrypted TEXT NULL DEFAULT NULL,    -- secretBox token; never plaintext
  base_dn VARCHAR(512) NOT NULL,
  user_filter VARCHAR(512) NOT NULL DEFAULT '(sAMAccountName={{username}})',
  group_filter VARCHAR(512) NULL DEFAULT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ldap_role_map (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ldap_group_dn VARCHAR(512) NOT NULL,
  blueeye_role ENUM('admin', 'operator', 'viewer') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ldap_role_map_group (ldap_group_dn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit trail for LDAP/AD login attempts (success + failure). Holds NO secrets.
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

-- The agent-release signing key (Ed25519), generated + managed from the
-- dashboard. The PRIVATE key is stored ENCRYPTED at rest (AES-256-GCM via
-- src/lib/secretBox.js) and is never returned by the API. At most one row.
CREATE TABLE IF NOT EXISTS agent_release_key (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  singleton TINYINT UNSIGNED NOT NULL DEFAULT 1,   -- enforces at most one key row
  public_pem TEXT NOT NULL,
  private_pem_encrypted TEXT NOT NULL,             -- secretBox token; never plaintext, never returned
  fingerprint CHAR(64) NOT NULL,                   -- sha256(public_pem), hex — a non-secret identifier
  created_by INT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_release_key_singleton (singleton)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NIS2 Reporting Center — a self-contained compliance module. All tables are
-- prefixed blueeye_nis2_* (+ blueeye_audit_log) so the module is cleanly
-- separable.

-- Risk register. risk_score is stored (likelihood * impact, both 1..5).
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
-- area; status reflects evidence health (OK / Partial / Missing / Overdue).
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

-- Security incidents (NIS2 sense — distinct from the network `incidents` table).
-- incident_id is a human reference (INC-YYYY-NNNN) generated by the repository.
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
-- time so the next report can show the delta. Draft until an admin approves.
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

-- Evidence references (document/link/screenshot), polymorphically attached to a
-- control / risk / incident / report. Stored as a reference, not a blob.
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
-- risk, control or incident; old_value/new_value hold JSON snapshots. Actor
-- identity is snapshotted (email) so the trail survives user changes.
CREATE TABLE IF NOT EXISTS blueeye_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NULL DEFAULT NULL,
  user_email VARCHAR(255) NULL DEFAULT NULL,
  action VARCHAR(32) NOT NULL,                    -- 'create' | 'update' | 'delete' | 'approve'
  entity_type VARCHAR(32) NOT NULL,               -- 'risk' | 'control' | 'incident' | 'report'
  entity_id INT UNSIGNED NULL DEFAULT NULL,
  old_value JSON NULL DEFAULT NULL,
  new_value JSON NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_log_entity (entity_type, entity_id),
  KEY idx_audit_log_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Unified, server-wide audit trail (Reporting → Audit). User actions (recorded
-- by the audit middleware) + agent activity (recorded on ingest). Recurring
-- activity is folded onto one row via the nullable UNIQUE dedup_key + INSERT ...
-- ON DUPLICATE KEY UPDATE (first run audited, repeats bump occurrences). No FK
-- on actor_id so agent rows survive the agent being deleted. Holds NO secrets —
-- request bodies are redacted before they reach `detail`.
CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_type VARCHAR(16) NOT NULL,             -- 'user' | 'agent' | 'system'
  actor_id INT UNSIGNED NULL DEFAULT NULL,
  actor_label VARCHAR(255) NULL DEFAULT NULL,  -- snapshot (e.g. user email)
  actor_role VARCHAR(32) NULL DEFAULT NULL,
  action VARCHAR(96) NOT NULL,                 -- dotted key, e.g. 'user.update', 'agent.run-test'
  target_type VARCHAR(64) NULL DEFAULT NULL,
  target_id VARCHAR(64) NULL DEFAULT NULL,
  target_label VARCHAR(255) NULL DEFAULT NULL,
  method VARCHAR(8) NULL DEFAULT NULL,
  path VARCHAR(255) NULL DEFAULT NULL,
  status INT NULL DEFAULT NULL,
  ip VARCHAR(64) NULL DEFAULT NULL,
  detail JSON NULL DEFAULT NULL,               -- redacted request body / extras
  repeat_interval_ms INT UNSIGNED NULL DEFAULT NULL,
  occurrences INT UNSIGNED NOT NULL DEFAULT 1,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dedup_key VARCHAR(255) NULL DEFAULT NULL,    -- NULL for discrete rows; set + UNIQUE for recurring
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_dedup (dedup_key),
  KEY idx_audit_ts (ts),
  KEY idx_audit_actor (actor_type, actor_id),
  KEY idx_audit_action (action),
  KEY idx_audit_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- CMDB integration (single source of truth) — migration 051. See docs/cmdb.md.
CREATE TABLE IF NOT EXISTS cmdb_config (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  type ENUM('servicenow', 'nautobot', 'custom') NOT NULL,
  base_url VARCHAR(512) NOT NULL,
  auth_type VARCHAR(32) NOT NULL DEFAULT 'none',
  config_json JSON NULL DEFAULT NULL,              -- custom connector settings (search path, field maps)
  credentials_encrypted TEXT NULL DEFAULT NULL,    -- secretBox token; never plaintext
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
  cmdb_asset_location VARCHAR(255) NULL DEFAULT NULL, -- syncs agents.location_id at link time
  linked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  linked_by INT UNSIGNED NULL DEFAULT NULL,
  PRIMARY KEY (agent_id),
  CONSTRAINT fk_agent_cmdb_links_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Remediation playbooks + their per-incident run history (migration 055). A
-- playbook is a pre-defined response keyed to an anomaly-type (trigger_condition
-- matches the incident's primary finding metric, exactly); incident_playbook_runs
-- records that a playbook ran against a specific incident and the outcome.
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

CREATE TABLE IF NOT EXISTS incident_playbook_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  incident_case_id BIGINT UNSIGNED NOT NULL,
  playbook_id INT UNSIGNED NOT NULL,
  status ENUM('pending', 'succeeded', 'failed') NOT NULL DEFAULT 'pending',
  result_text TEXT NULL DEFAULT NULL,
  ran_by VARCHAR(120) NULL DEFAULT NULL,
  ran_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_incident_playbook_runs_incident (incident_case_id, ran_at),
  KEY idx_incident_playbook_runs_playbook (playbook_id),
  CONSTRAINT fk_incident_playbook_runs_incident FOREIGN KEY (incident_case_id)
    REFERENCES incident_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_incident_playbook_runs_playbook FOREIGN KEY (playbook_id)
    REFERENCES remediation_playbooks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cross-agent incident clusters (migration 056): findings from DIFFERENT agents
-- within a short time window, grouped with a suspected common cause + confidence
-- tier (time-only=low, +shared site=medium, +same finding-type=high). member_finding_ids
-- is a JSON array of findings.id. See src/analysis/crossAgentCorrelator.js.
CREATE TABLE IF NOT EXISTS incident_clusters (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  confidence ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'low',
  member_finding_ids JSON NOT NULL,
  suspected_common_cause TEXT NULL DEFAULT NULL,
  advisory TEXT NULL DEFAULT NULL,                     -- opt-in AI root-cause + troubleshooting (migration 057)
  status ENUM('open', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  detected_at DATETIME NOT NULL,
  resolved_at DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_incident_clusters_status_detected (status, detected_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
