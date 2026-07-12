-- 051 — CMDB integration (single source of truth). Two tables:
--
--   cmdb_config       a SINGLE-ROW connection config for exactly ONE CMDB source
--                     (ServiceNow or Nautobot). Credentials are ENCRYPTED at rest
--                     (AES-256-GCM via src/lib/secretBox.js) in credentials_encrypted
--                     — never plaintext, never returned by the API. verified_at is
--                     stamped when POST /api/settings/cmdb/test reaches the upstream.
--
--   agent_cmdb_links  links a BlueEye agent to one CMDB asset (searchable dropdown
--                     in the agent detail page). One row per agent (agent_id PK); the
--                     FK cascades on agent delete so a removed agent takes its link.
--
-- Only ONE CMDB source is supported by design (single source of truth), so
-- cmdb_config is treated as a singleton — the repository upserts the lowest-id row.
CREATE TABLE IF NOT EXISTS cmdb_config (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  type ENUM('servicenow', 'nautobot') NOT NULL,
  base_url VARCHAR(512) NOT NULL,
  auth_type VARCHAR(32) NOT NULL DEFAULT 'none',   -- 'basic' | 'oauth2' | 'token' | 'none'
  credentials_encrypted TEXT NULL DEFAULT NULL,    -- secretBox token; never plaintext
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  verified_at DATETIME NULL DEFAULT NULL,          -- last successful connection test
  updated_by INT UNSIGNED NULL DEFAULT NULL,       -- user id of the last editor
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_cmdb_links (
  agent_id INT UNSIGNED NOT NULL,                  -- one link per agent
  cmdb_asset_id VARCHAR(255) NOT NULL,
  cmdb_asset_name VARCHAR(255) NOT NULL,
  cmdb_asset_location VARCHAR(255) NULL DEFAULT NULL, -- asset's CMDB location label, captured at link time (informational; does NOT touch agents.location_id)
  linked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  linked_by INT UNSIGNED NULL DEFAULT NULL,        -- user id who linked it
  PRIMARY KEY (agent_id),
  CONSTRAINT fk_agent_cmdb_links_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
