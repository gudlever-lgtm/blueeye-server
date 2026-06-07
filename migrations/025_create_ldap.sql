-- 025 — external auth via LDAP/AD (supplements local JWT login). A single-row
-- connection config (ldap_config) + a group-to-role map (ldap_role_map). The same
-- code path serves Microsoft AD and OpenLDAP; the difference is just the filters.
-- The bind password is ENCRYPTED at rest (AES-256-GCM via src/lib/secretBox.js) in
-- bind_pw_encrypted — never plaintext, never returned by the API. LDAP login is
-- gated behind LDAP_AUTH_ENABLED (default false) AND ldap_config.enabled.
CREATE TABLE IF NOT EXISTS ldap_config (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  host VARCHAR(255) NOT NULL,
  port INT UNSIGNED NOT NULL DEFAULT 389,
  use_tls TINYINT(1) NOT NULL DEFAULT 1,       -- LDAPS; a plaintext bind is rejected off-localhost
  bind_dn VARCHAR(512) NULL DEFAULT NULL,      -- service account for the user search (NULL = anonymous)
  bind_pw_encrypted TEXT NULL DEFAULT NULL,    -- secretBox token; never plaintext
  base_dn VARCHAR(512) NOT NULL,
  user_filter VARCHAR(512) NOT NULL DEFAULT '(sAMAccountName={{username}})',
  group_filter VARCHAR(512) NULL DEFAULT NULL, -- optional: look up groups by member when memberOf is absent
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Maps an LDAP/AD group DN to a BlueEye role. On login the user's groups are
-- looked up and the HIGHEST matching role wins (admin > operator > viewer). NO
-- match means access is DENIED — there is deliberately no default role.
CREATE TABLE IF NOT EXISTS ldap_role_map (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ldap_group_dn VARCHAR(512) NOT NULL,
  blueeye_role ENUM('admin', 'operator', 'viewer') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ldap_role_map_group (ldap_group_dn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
