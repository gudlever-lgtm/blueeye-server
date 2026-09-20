-- 106 — snmp_neighbors: LLDP as seen BY A SWITCH.
--
-- WHY THIS IS NOT `lldp_neighbors` (migration 063).
--
-- That table keys on `local_agent_id`, which is an `agents` id. An SNMP device
-- lives in `snmp_devices` (104) with its own id sequence, so writing a device id
-- into that column would collide with agent ids and silently attribute a
-- switch's neighbours to whichever agent happened to share the number. The
-- topology graph reads that table; a collision there does not throw, it just
-- draws the wrong network — the worst failure mode this product has.
--
-- So: a separate table with a foreign key to the right parent, and the merge
-- into the topology graph left as its own decision. That decision is genuinely
-- architectural — a switch sees far more neighbours than an agent host does,
-- including every access point and phone, and folding the two sources together
-- changes what the graph MEANS. It deserves its own change with its own
-- reasoning, not a column reused because it was nearby.
--
-- The data is collected and stored now so nothing is lost while that decision
-- waits, and `GET /api/snmp-devices/:id` serves it per device.
CREATE TABLE IF NOT EXISTS `snmp_neighbors` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  -- The port on THIS switch the neighbour is seen on. Both the raw LLDP local
  -- port number and the resolved interface, for the same reason fdb_entries
  -- keeps both: the resolution can fail, and a null name is honest where an
  -- invented one is not.
  `local_port` INT UNSIGNED NULL DEFAULT NULL,
  `local_if_index` INT UNSIGNED NULL DEFAULT NULL,
  `local_if_name` VARCHAR(64) NULL DEFAULT NULL,
  -- The neighbour's chassis id: a MAC, a name, or an opaque local id. Which of
  -- those it is was decided by the device's own subtype column on the agent —
  -- length cannot tell a MAC from a name, since "Gi0/24" is exactly six bytes.
  `remote_chassis_id` VARCHAR(255) NOT NULL,
  `remote_port_id` VARCHAR(255) NULL DEFAULT NULL,
  `remote_port_desc` VARCHAR(255) NULL DEFAULT NULL,
  `remote_sys_name` VARCHAR(255) NULL DEFAULT NULL,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  -- One row per adjacency. A neighbour that moves to another port rewrites the
  -- port in place rather than accumulating a second row.
  UNIQUE KEY `uq_snmp_neighbors` (`device_id`, `remote_chassis_id`, `remote_port_id`),
  KEY `idx_snmp_neighbors_device` (`device_id`, `last_seen`),
  KEY `idx_snmp_neighbors_remote` (`remote_chassis_id`),
  KEY `idx_snmp_neighbors_last_seen` (`last_seen`),
  CONSTRAINT `fk_snmp_neighbors_device` FOREIGN KEY (`device_id`) REFERENCES `snmp_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
