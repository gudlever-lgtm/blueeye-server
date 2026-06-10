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
  category VARCHAR(32) NOT NULL,                 -- auth | user | role | license | report | api_token | system
  action VARCHAR(64) NOT NULL,                   -- e.g. login_success, user_create, license_revalidate
  outcome ENUM('success', 'failure', 'denied') NOT NULL DEFAULT 'success',
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,  -- the acting user, when known (NULL for anonymous/system)
  actor_email VARCHAR(255) NULL DEFAULT NULL,    -- denormalised so the trail survives user deletion
  actor_role VARCHAR(32) NULL DEFAULT NULL,
  target VARCHAR(255) NULL DEFAULT NULL,          -- the affected entity (e.g. user email, report id, token name)
  detail VARCHAR(512) NULL DEFAULT NULL,          -- short human summary; never secrets/payload
  ip VARCHAR(64) NULL DEFAULT NULL,               -- request source IP, when available
  PRIMARY KEY (id),
  KEY idx_audit_log_created (created_at),
  KEY idx_audit_log_category (category, created_at),
  KEY idx_audit_log_actor (actor_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
