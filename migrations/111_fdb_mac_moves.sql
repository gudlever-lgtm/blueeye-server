-- 111 — fdb_entries remembers that a MAC MOVED.
--
-- WHY. A forwarding loop's signature is a MAC address that keeps appearing on
-- two different ports of the same switch, over and over, within seconds. It is
-- the classic one — Cisco's own %SW_MATM-4-MACFLAP_NOTIF says exactly this —
-- and it is visible in data BlueEyes already collects.
--
-- It was not visible in what BlueEyes already STORED. `fdb_entries.upsertMany`
-- rewrites `bridge_port` in place: a MAC that moved leaves no trace that it
-- ever sat anywhere else, so consecutive sweeps of a switch in a loop look
-- exactly like consecutive sweeps of a quiet switch. The information was
-- arriving and being overwritten.
--
-- THREE COLUMNS, NOT A HISTORY TABLE. What a loop detector needs is "how often
-- is this MAC changing port, and between which two" — a count and the previous
-- port, not a row per observation. A history table for a forwarding database
-- would be the largest table in the schema within a week, to answer a question
-- nobody asks: where a MAC was three weeks ago is something the SWITCH forgets
-- in minutes.
--
-- `move_count` is monotonic per (device, vlan, mac) and reset by nothing. The
-- detector reads it as a DELTA over a window, the same way a counter is read,
-- which is why it never needs to be cleared.
ALTER TABLE `fdb_entries`
  -- The port this MAC was on BEFORE the current one. NULL until it moves once.
  ADD COLUMN `prev_bridge_port` INT UNSIGNED NULL DEFAULT NULL AFTER `bridge_port`,
  -- How many times it has moved, ever.
  ADD COLUMN `move_count` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `prev_bridge_port`,
  -- When it last moved. A MAC that moved four times yesterday and has been
  -- still since is not a loop today.
  ADD COLUMN `last_move_at` DATETIME NULL DEFAULT NULL AFTER `move_count`;

-- "Which MACs on this switch are moving, and when did they last move" — the
-- only query the loop detector makes against this table.
CREATE INDEX `idx_fdb_moves` ON `fdb_entries` (`device_id`, `last_move_at`);
