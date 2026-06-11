-- 038 — SSO via SAML 2.0 (SP-initiated). Supplements local JWT login behind the
-- licence feature `sso_saml` (Enterprise+). The IdP connection (entry point / SP
-- entityID / audience / signing certificate) comes from ENV VARS — see
-- src/config.js `saml` — so there is no connection-config table; only the
-- attribute→role map lives in the DB. Login attempts are recorded in the shared
-- `sso_login_audit` table (migration 037).

-- Maps a SAML attribute value (a group/role name from the configured role
-- attribute, default `groups`) to a BlueEye role. On login the user's attribute
-- values are looked up and the HIGHEST matching role wins (admin > operator >
-- viewer). NO match means access is DENIED — there is deliberately no default
-- role. The column is named `claim_value` to share the generic role-map surface
-- with OIDC (oidc_role_map).
CREATE TABLE IF NOT EXISTS saml_role_map (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  claim_value VARCHAR(512) NOT NULL,
  blueeye_role ENUM('admin', 'operator', 'viewer') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_saml_role_map_claim (claim_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
