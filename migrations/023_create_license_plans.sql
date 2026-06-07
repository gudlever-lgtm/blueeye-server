-- 023 — license plans + local licenses (offline-license readiness).
--
-- The CODE's source of truth for plan capabilities is src/license/plans.js (so
-- gating works with zero DB round-trips and is trivially testable). These tables
-- MIRROR that catalogue for the admin UI / reporting and provide the structure
-- the offline signed-license model will populate later (signed_payload +
-- signature verified by src/license/). They are intentionally additive — no
-- existing table is touched — and the seed below is idempotent.

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
  -- Offline-license readiness: the signed payload + Ed25519 signature. NULL
  -- until an offline license file is imported. Never used as an access token.
  signed_payload JSON NULL,
  signature VARCHAR(512) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_license_status (license_status),
  CONSTRAINT fk_license_plan FOREIGN KEY (plan_key)
    REFERENCES license_plans (plan_key) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed / refresh the catalogue. ON DUPLICATE KEY UPDATE keeps the migration
-- idempotent and lets a later re-run pick up price/feature changes. Must stay in
-- sync with src/license/plans.js (covered by a test).
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
              'reports_csv', 'reports_sla', 'rbac', 'audit_log', 'api_access',
              'alerts_email', 'alerts_webhook'),
   'standard', 0, 0, 0, 0, 12000, 90000, 0),
  ('enterprise', 'Enterprise', NULL, NULL, 1095,
   JSON_ARRAY('dashboard_basic', 'dashboard_advanced', 'reports_basic', 'reports_pdf',
              'reports_csv', 'reports_sla', 'rbac', 'audit_log', 'api_access',
              'alerts_email', 'alerts_webhook', 'reports_compliance', 'sso_oidc',
              'sso_saml', 'ha_deployment', 'offline_license', 'security_pack',
              'premium_support'),
   'premium', 0, 0, 0, 1, 25000, 187000, 1),
  ('msp', 'MSP', NULL, NULL, 1095,
   JSON_ARRAY('dashboard_basic', 'dashboard_advanced', 'reports_basic', 'reports_pdf',
              'reports_csv', 'reports_sla', 'rbac', 'audit_log', 'api_access',
              'alerts_email', 'alerts_webhook', 'reports_compliance', 'sso_oidc',
              'sso_saml', 'ha_deployment', 'offline_license', 'security_pack',
              'premium_support', 'msp_multitenant'),
   'partner', 0, 0, 1, 1, 15000, 112000, 1)
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
