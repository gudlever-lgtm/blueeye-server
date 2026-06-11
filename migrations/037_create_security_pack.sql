-- 037 — Security pack (Enterprise feature `security_pack`).
--
-- Adds the persistent state behind four enforced security controls. The
-- *configuration* for each (toggles, thresholds, CIDR allowlists) lives in
-- app_settings under the `security` key — only durable per-user/per-source state
-- is tabled here. Everything is metadata only: NEVER plaintext passwords.
--
--   1. Password policy   — password_history + users.password_changed_at let us
--      enforce "no reuse of the last N" and "max age".
--   2. Brute-force lockout — auth_lockouts counts failed logins per user and per
--      source IP and stores the current lockout deadline (exponential backoff).
--   3. IP allowlisting   — config-only (security.ipAllowlist), no table needed.
--   4. Stricter audit    — audit_log gains a per-row hash chain (prev_hash +
--      entry_hash) so the trail is append-only / tamper-evident.

-- ---- 1. Password history + age ------------------------------------------------
-- Past password hashes, newest-first by id, so a change can refuse to reuse the
-- last N. Hashes only (bcrypt) — never plaintext. Dropped with the user.
CREATE TABLE IF NOT EXISTS password_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_password_history_user (user_id, id),
  CONSTRAINT fk_password_history_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- When the current password was last set — drives the max-age check at login.
-- NULL on existing rows means "unknown"; treated as not-expired until next change.
ALTER TABLE users
  ADD COLUMN password_changed_at DATETIME NULL DEFAULT NULL AFTER password_hash;

-- ---- 2. Brute-force lockout ---------------------------------------------------
-- One row per (scope, identifier): scope is 'user' (the login email) or 'ip'
-- (the source address). fail_count is the running streak of failures; on success
-- the row is reset. locked_until holds the current backoff deadline (NULL = not
-- locked). Both scopes are checked at login; whichever is locked yields a 429.
CREATE TABLE IF NOT EXISTS auth_lockouts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope ENUM('user', 'ip') NOT NULL,
  identifier VARCHAR(255) NOT NULL,
  fail_count INT UNSIGNED NOT NULL DEFAULT 0,
  first_failed_at DATETIME NULL DEFAULT NULL,
  last_failed_at DATETIME NULL DEFAULT NULL,
  locked_until DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_lockouts_scope_ident (scope, identifier),
  KEY idx_auth_lockouts_locked (locked_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- 4. Tamper-evident audit log ----------------------------------------------
-- Each audit_log row is chained to the previous one: entry_hash =
-- sha256(prev_hash || canonical(row fields)). A break anywhere in the chain means
-- a row was altered or removed, so the trail is append-only by construction.
-- NULL on rows written before this migration (the chain starts at the first row
-- written after it).
ALTER TABLE audit_log
  ADD COLUMN prev_hash CHAR(64) NULL DEFAULT NULL,
  ADD COLUMN entry_hash CHAR(64) NULL DEFAULT NULL;
