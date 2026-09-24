-- 117 — VLAN names per switch, and a short history of MAC MOVES.
--
-- device_vlans. The agent has sent the Q-BRIDGE VLAN names (dot1qVlanStaticName)
-- on every topology poll and the validator has accepted them; nothing stored
-- them. "VLAN 20" on a port or in a loop finding is a number somebody has to go
-- and look up; "VLAN 20 (Voice)" is an answer. One row per (device, vlan),
-- upserted on last_seen and aged out with the forwarding table it describes
-- (RETENTION_FDB_DAYS) — a VLAN deleted from the switch simply stops being
-- refreshed, the same ageing rule fdb_entries follows.
--
-- fdb_mac_moves. Migration 111 gave fdb_entries a `move_count` — monotonic,
-- reset by nothing — and the loop detector then read that ALL-TIME count as if
-- it were the number of moves inside its ten-minute window. A laptop that had
-- been re-docked forty times over a month looked, to the detector, like a MAC
-- flapping forty times in ten minutes. A window needs to know WHEN each move
-- happened, and a single counter cannot say.
--
-- So the moves themselves are kept, one row per observed move, written by the
-- same sweep that records it on fdb_entries (an INSERT … SELECT of the rows
-- whose last_move_at is this sweep — no read-compare-write per MAC). "How many
-- times did this MAC move in the last N minutes" is then a COUNT over an
-- indexed range, exact for whatever window the detector asks for.
--
-- WHY THIS IS NOT THE "HISTORY TABLE NOBODY NEEDS" 111 WARNED AGAINST. That
-- note was about a row per MAC per SWEEP — every observation. This is a row per
-- MOVE, which on a quiet network is a handful a day, and it has its own SHORT
-- retention (RETENTION_FDB_MOVE_DAYS, default 2): the question it answers is
-- about the last few minutes, and the rows exist to answer it and then go.
-- move_count on fdb_entries stays as the all-time figure it always was.
CREATE TABLE IF NOT EXISTS `device_vlans` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  `vlan` SMALLINT UNSIGNED NOT NULL,
  `name` VARCHAR(64) NOT NULL,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device_vlans` (`device_id`, `vlan`),
  KEY `idx_device_vlans_last_seen` (`last_seen`),
  CONSTRAINT `fk_device_vlans_device` FOREIGN KEY (`device_id`) REFERENCES `snmp_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per observed move of one MAC on one switch. `from_port`/`to_port` are
-- BRIDGE port numbers, exactly as fdb_entries stores them (see 105 for why a
-- bridge port is not an ifIndex).
CREATE TABLE IF NOT EXISTS `fdb_mac_moves` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  `mac` CHAR(17) NOT NULL,
  `vlan` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `from_port` INT UNSIGNED NULL DEFAULT NULL,
  `to_port` INT UNSIGNED NOT NULL,
  `moved_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  -- The detector's read: the moves of one device's MACs since the window opened.
  KEY `idx_fdb_moves_mac` (`device_id`, `vlan`, `mac`, `moved_at`),
  KEY `idx_fdb_moves_device` (`device_id`, `moved_at`),
  -- Retention ages by moved_at.
  KEY `idx_fdb_moves_at` (`moved_at`),
  CONSTRAINT `fk_fdb_moves_device` FOREIGN KEY (`device_id`) REFERENCES `snmp_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
