-- 110 — findings can name a DEVICE and a PORT, not only a host.
--
-- THE DECISION THIS SETTLES. Until now `findings.host_id` is an agent, and
-- everything downstream assumes it: the index, the correlator, event_cases, the
-- timeline, alerting. A switch port that is dropping frames had nowhere to go.
--
-- There were two ways out, and only one of them is honest.
--
--   1. Encode device+port into `host_id` as a string. Works immediately and
--      destroys every join to `agents`, silently, for everything that reads
--      findings.
--   2. Give findings the two columns. Touches the most central table in the
--      product, and leaves the model intact.
--
-- This is (2). The alternative to both — a second findings table for devices —
-- was rejected for the reason `event_cases` exists at all: two places to look
-- for "something is wrong" is what this product was built to stop being.
--
-- BOTH COLUMNS ARE NULLABLE and every existing row keeps its meaning. A finding
-- about an agent has NULL in both, exactly as before; a finding about a switch
-- port has a device and a port and carries `host_id` as the POLLING agent's id,
-- so the existing per-agent reads still find it. Nothing needs backfilling and
-- no read has to change to keep working.
--
-- No foreign keys, matching the table's existing shape (`findings` has one to
-- `event_cases` and none to `agents`): a finding is a record of a moment, and
-- deleting a switch from the inventory must not delete the evidence that it was
-- misbehaving.
ALTER TABLE `findings`
  ADD COLUMN `device_id` INT UNSIGNED NULL DEFAULT NULL AFTER `host_id`,
  ADD COLUMN `interface_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `device_id`;

-- "What is wrong on this switch", and "what has this port been doing" — the two
-- questions a device page asks. Both are scoped by time like every other read of
-- this table.
CREATE INDEX `idx_findings_device_created` ON `findings` (`device_id`, `created_at`);
CREATE INDEX `idx_findings_interface_created` ON `findings` (`interface_id`, `created_at`);
