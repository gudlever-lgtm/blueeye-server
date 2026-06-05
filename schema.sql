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
-- kept in sync as a convenient full picture of the current schema.

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
  display_name VARCHAR(255) NULL DEFAULT NULL,
  notes TEXT NULL DEFAULT NULL,
  meta JSON NULL DEFAULT NULL,
  monitor_config JSON NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_agents_location_id (location_id),
  CONSTRAINT fk_agents_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One-time codes used to enroll new agents.
CREATE TABLE IF NOT EXISTS enrollment_codes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  created_by INT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
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
  KEY idx_results_agent_id (agent_id),
  CONSTRAINT fk_results_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
