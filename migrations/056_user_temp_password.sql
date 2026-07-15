-- 056 — local user creation with a one-time (temporary) password.
--
-- For customers that do NOT use SSO/LDAP, an admin can create a local user who
-- receives a cryptographically-random one-time password by email and is forced
-- to change it on first login. Three columns support that flow:
--
--   must_change_password     — while 1, the user's JWT is flagged and every API
--                              route except the change-password flow returns 403,
--                              so the user cannot use the system until they pick
--                              a new password that meets the standard policy.
--   temp_password_expires_at — the one-time password is only valid until this
--                              instant (default 48h); a login after it is refused
--                              with a clear error (not a 500) and the admin can
--                              regenerate/resend a fresh one.
--   temp_password_created_by — the admin who issued the one-time password, kept
--                              for the audit trail (ON DELETE SET NULL so removing
--                              that admin never blocks deleting them).
--
-- Privacy/security: the one-time password itself is NEVER stored in clear text —
-- only its bcrypt hash lands in password_hash, exactly like any other password.
ALTER TABLE users
  ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN temp_password_expires_at DATETIME NULL DEFAULT NULL,
  ADD COLUMN temp_password_created_by INT UNSIGNED NULL DEFAULT NULL,
  ADD CONSTRAINT fk_users_temp_pw_creator
    FOREIGN KEY (temp_password_created_by) REFERENCES users (id) ON DELETE SET NULL;
