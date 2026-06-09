-- 033 — API tokens for programmatic access (license feature `api_access`,
-- Professional+). A token authenticates REST calls without an interactive login
-- and acts with a fixed role (viewer/operator/admin).
--
-- Only the SHA-256 HASH of the token is stored (token_hash) — the plaintext is
-- shown to the operator once at creation and is unrecoverable thereafter, the
-- same posture as agent tokens and encrypted secrets elsewhere. token_prefix is
-- a short, non-secret fragment kept only so the UI can identify a token in a list.
CREATE TABLE IF NOT EXISTS api_tokens (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,                    -- human label, e.g. "CI pipeline"
  token_prefix VARCHAR(32) NOT NULL,             -- non-secret display fragment ("blueeye_AbC123")
  token_hash CHAR(64) NOT NULL,                  -- sha-256 hex of the full token; never the token itself
  role ENUM('admin', 'operator', 'viewer') NOT NULL DEFAULT 'viewer',
  created_by_user_id INT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NULL DEFAULT NULL,
  expires_at TIMESTAMP NULL DEFAULT NULL,        -- NULL = no expiry
  revoked_at TIMESTAMP NULL DEFAULT NULL,        -- NULL = active; set = revoked
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_tokens_hash (token_hash),
  KEY idx_api_tokens_active (revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
