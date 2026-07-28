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
--
-- The cleartext column then goes away ENTIRELY, in this migration. Keeping it
-- for pre-existing rows was tempting — their install command stays displayable —
-- but nothing in the system ever deletes an enrollment_codes row, so those
-- cleartext codes would sit in the table for good. That would leave exactly the
-- exposure this migration exists to remove, and "it drains on its own" is simply
-- not true here.
--
-- What the drop costs, precisely: an enrollment code minted before this
-- migration STILL WORKS — SHA2() below backfills its hash, and both the claim
-- path and the public install.sh endpoint match on that hash. The only thing
-- lost is re-DISPLAYING the one-liner for such a code (the endpoint answers 409
-- "generate a new one"). Codes are short-lived — the default TTL is an hour — so
-- that window is small, and minting a new code is one click.
--
-- EVERY STEP IS GUARDED against having already been applied. This migration
-- shipped first as 072 and was renumbered when main took that number for
-- incident_notes — and `schema_migrations` tracks migrations by FILENAME, so a
-- database that ran the 072 file has no row for this one and the runner runs it
-- AGAIN. Unguarded, the first ALTER then dies on "Duplicate column name
-- 'code_hash'"; because the container runs `migrate && server`, that failure
-- takes the whole server down rather than just the migration. The
-- information_schema checks below make a re-run a no-op instead. (MySQL has no
-- ADD COLUMN IF NOT EXISTS, hence the prepared-statement dance; `DO 0` is the
-- no-op branch.)
--
-- The statement ORDER is load-bearing: the hash is backfilled FROM the
-- cleartext, so the backfill must run while that column still exists. Dropping
-- first would leave every outstanding code unredeemable — every agent
-- mid-install failing, with no way to recover the codes.
-- test/enrollmentCodeAtRest.test.js asserts both the order and the guards.
SET @db := DATABASE();

-- 1. The lookup column.
SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'enrollment_codes' AND COLUMN_NAME = 'code_hash');
SET @sql := IF(@exists = 0,
  'ALTER TABLE enrollment_codes ADD COLUMN code_hash CHAR(64) NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. The encrypted-at-rest copy.
SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'enrollment_codes' AND COLUMN_NAME = 'code_enc');
SET @sql := IF(@exists = 0,
  'ALTER TABLE enrollment_codes ADD COLUMN code_enc TEXT NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Backfill, while the cleartext is still there to hash. MySQL's SHA2 produces
--    the same digest the application does, so existing codes stay redeemable.
SET @have_code := (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'enrollment_codes' AND COLUMN_NAME = 'code');
SET @sql := IF(@have_code = 1,
  'UPDATE enrollment_codes SET code_hash = SHA2(code, 256) WHERE code IS NOT NULL AND code_hash IS NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Lookups go through the hash from here on. Unique for the same reason the
--    old `code` index was: a code identifies exactly one row.
SET @exists := (SELECT COUNT(*) FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'enrollment_codes' AND INDEX_NAME = 'uq_enrollment_codes_code_hash');
SET @sql := IF(@exists = 0,
  'CREATE UNIQUE INDEX uq_enrollment_codes_code_hash ON enrollment_codes (code_hash)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5. The cleartext is gone. Dropping the column also drops the unique index over
--    it (it indexes that column alone), so the index is not named here — one less
--    thing to get wrong on a deployment whose index name differs.
SET @sql := IF(@have_code = 1,
  'ALTER TABLE enrollment_codes DROP COLUMN code',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
