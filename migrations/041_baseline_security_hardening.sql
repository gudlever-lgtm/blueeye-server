-- 041 — Baseline security hardening (always-on, not licence-gated).
--
-- Adds the persistent state behind three baseline security controls that
-- complement the always-on headers / login lockout / password-complexity already
-- shipped in the baseline. Configuration (history depth, max age, IP allowlist
-- CIDRs) lives in app_settings under the `security` key; only durable state is
-- tabled here. Metadata only — NEVER plaintext passwords.
--
--   1. Password history + age — refuse reuse of the last N passwords and (opt-in)
--      force a change after a max age.
--   2. Role-based IP allowlist — config-only (security.ipAllowlist), no table.
--   3. Tamper-evident audit log — audit_log gains a per-row hash chain.

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

-- When the current password was last set — drives the (opt-in) max-age check.
-- NULL on existing rows means "unknown"; treated as not-expired until next change.
ALTER TABLE users
  ADD COLUMN password_changed_at DATETIME NULL DEFAULT NULL AFTER password_hash;

-- ---- 3. Tamper-evident audit log ----------------------------------------------
-- Each audit_log row is chained to the previous one: entry_hash =
-- sha256(prev_hash || canonical(row fields)). A break anywhere in the chain means
-- a row was altered or removed, so the trail is append-only by construction.
-- NULL on rows written before this migration (the chain starts at the first row
-- written after it).
ALTER TABLE audit_log
  ADD COLUMN prev_hash CHAR(64) NULL DEFAULT NULL,
  ADD COLUMN entry_hash CHAR(64) NULL DEFAULT NULL;
