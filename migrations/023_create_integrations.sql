-- 023 — outbound API integrations (ITSM/IPAM connectors). One row per configured
-- target system: ServiceNow (incidents), Nautobot (device/site sync), a generic
-- webhook, and future connectors. Credentials are ENCRYPTED at rest (AES-256-GCM
-- via src/lib/secretBox.js) in credentials_encrypted — NEVER plaintext, and never
-- returned by the API. config_json holds non-secret, connector-specific settings
-- (which events to fire on, the ServiceNow table, the Nautobot allow-delete flag).
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
