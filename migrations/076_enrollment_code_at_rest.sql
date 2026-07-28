-- 076 — stop keeping enrollment codes in cleartext.
--
-- An enrollment code is a credential: whoever holds one can enroll a machine
-- into the fleet as a trusted agent. Until now it was stored verbatim in
-- `enrollment_codes.code`, so any read of the database (a backup, a dump, a
-- read-only SQL injection) yielded usable credentials — unlike agent tokens,
-- which have only ever been stored as a SHA-256 hash (src/auth/tokens.js).
--
-- Codes cannot simply be hashed, though: the authenticated
-- "regenerate the install command for this code" endpoint has to reproduce the
-- code itself. So the two jobs are split across two columns:
--   code_hash — SHA-256, what every LOOKUP matches on (indexed, constant shape)
--   code_enc  — the code encrypted with secretBox (AES-256-GCM), what the
--               install-command endpoint decrypts for display
-- and `code` becomes nullable so new rows never write cleartext at all.
--
-- Backfill: hash every existing row (MySQL's SHA2 produces the same digest the
-- application does), then blank the cleartext of codes that can no longer be
-- used anyway — spent or expired. ACTIVE codes keep their cleartext until they
-- expire, because they have no code_enc to decrypt and the install-command
-- endpoint must keep working for them; the repository falls back to `code` for
-- exactly those rows. Codes are short-lived, so the legacy column drains on its
-- own and a later migration can drop it.
ALTER TABLE enrollment_codes
  ADD COLUMN code_hash CHAR(64) NULL DEFAULT NULL AFTER code,
  ADD COLUMN code_enc TEXT NULL DEFAULT NULL AFTER code_hash,
  MODIFY COLUMN code VARCHAR(64) NULL DEFAULT NULL;

UPDATE enrollment_codes
   SET code_hash = SHA2(code, 256)
 WHERE code IS NOT NULL AND code_hash IS NULL;

UPDATE enrollment_codes
   SET code = NULL
 WHERE code IS NOT NULL
   AND (uses_remaining <= 0 OR expires_at <= NOW());

-- Lookups go through the hash from here on. Unique for the same reason the old
-- `code` index was: a code identifies exactly one row.
CREATE UNIQUE INDEX uq_enrollment_codes_code_hash ON enrollment_codes (code_hash);
