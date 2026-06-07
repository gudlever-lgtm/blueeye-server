-- 029 — audit trail for LDAP/AD login attempts (success + failure). Records the
-- username, the outcome + reason, how many groups matched a role, the granted
-- role, and the source IP. Holds NO secrets — passwords are never written here.
-- Local JWT logins are unchanged; this only covers the external-auth path.
CREATE TABLE IF NOT EXISTS ldap_login_audit (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(255) NULL DEFAULT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  reason VARCHAR(64) NULL DEFAULT NULL,        -- 'ok' | 'bind-failed' | 'no-role' | 'tls-required' | 'unavailable' | 'invalid-input'
  granted_role VARCHAR(32) NULL DEFAULT NULL,
  groups_matched INT UNSIGNED NOT NULL DEFAULT 0,
  source_ip VARCHAR(64) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ldap_login_audit_user (username, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
