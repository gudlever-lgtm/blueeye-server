-- 148 — a SECOND managed signing key on this server: the one that signs
-- privileged agent COMMANDS, separate from the one that signs agent RELEASES.
--
-- Why two. One key signing both the code an agent installs and the instructions
-- it obeys means a compromise of that key yields both — and the two want
-- opposite handling. A release key is used on a build step a few times a month;
-- a command key is used every time an operator presses Update, so it has to be
-- online and decryptable here all day.
--
-- The table was a singleton (`UNIQUE KEY (singleton)`). It becomes one row per
-- PURPOSE: the uniqueness moves to (singleton, purpose), so each purpose is
-- still write-once and there is still no way to end up with two release keys.
-- MySQL treats NULLs as distinct in a unique index, so the existing row (whose
-- purpose is NULL) and a later explicit 'release' row would both be allowed —
-- which is why the repository always writes the purpose explicitly and reads
-- NULL as 'release', and why nothing ever inserts a second release key.
--
-- Guarded with the prepared-statement idiom (076/077/116), because this has to
-- be re-runnable: the container runs `migrate && server`, so an unguarded
-- ALTER that meets its own result takes the server down on the next deploy.
--
-- Backward compatible. The existing row becomes the 'release' key by the column
-- default, and a server with no command key signs commands with the release key
-- exactly as before — see docs/command-signing.md.

-- NULLable, with no default, and NULL reads as 'release' in the repository.
-- Two reasons. The row that already exists IS the release key, so NULL is the
-- honest value for it rather than a backfill that pretends it was always
-- labelled. And a NOT NULL DEFAULT would put a quoted string inside the guard's
-- SQL literal, which the snapshot builder cannot parse — a migration the
-- snapshot cannot read is one `npm test` cannot check.
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'agent_release_key'
                      AND column_name = 'purpose'),
  'DO 0',
  'ALTER TABLE agent_release_key ADD COLUMN purpose VARCHAR(16) NULL DEFAULT NULL AFTER singleton');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'agent_release_key'
                      AND index_name = 'uq_agent_release_key_singleton'),
  'ALTER TABLE agent_release_key DROP INDEX uq_agent_release_key_singleton',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'agent_release_key'
                      AND index_name = 'uq_agent_release_key_purpose'),
  'DO 0',
  'ALTER TABLE agent_release_key ADD UNIQUE KEY uq_agent_release_key_purpose (singleton, purpose)');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
