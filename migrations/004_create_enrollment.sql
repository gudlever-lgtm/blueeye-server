-- 004 — enrollment codes + agent tokens.

-- One-time codes used to enroll new agents. The `code` is random and unique;
-- it is returned to the operator once at creation.
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
  CONSTRAINT fk_agent_tokens_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
