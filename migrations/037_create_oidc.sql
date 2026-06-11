-- 037 — SSO via OpenID Connect (authorization-code + PKCE). Supplements local
-- JWT login behind the licence feature `sso_oidc` (Enterprise+). The IdP
-- connection (issuer/client id/secret/redirect) comes from ENV VARS — see
-- src/config.js `oidc` — so there is no connection-config table; only the
-- group→role map and the (shared) login-audit trail live in the DB.

-- Maps an OIDC claim value (a group/role name from the id-token `groups` claim,
-- configurable via OIDC_ROLE_CLAIM) to a BlueEye role. On login the user's claim
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
  provider VARCHAR(16) NOT NULL DEFAULT 'oidc',   -- 'oidc' | 'saml'
  subject VARCHAR(255) NULL DEFAULT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  reason VARCHAR(64) NULL DEFAULT NULL,            -- 'ok' | 'no-role' | 'invalid-token' | 'token-failed' | ...
  granted_role VARCHAR(32) NULL DEFAULT NULL,
  groups_matched INT UNSIGNED NOT NULL DEFAULT 0,
  source_ip VARCHAR(64) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sso_login_audit_provider (provider, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
