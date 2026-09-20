-- 108 — device_interfaces: the ports on a polled switch, as their own inventory.
--
-- WHY THIS IS NOT `interface_states` (mig. 088). That table keys on
-- (agent_id, iface) with ON DELETE CASCADE to `agents`: an interface there is a
-- NIC on a host we run on. A port on a switch is a different thing with a
-- different owner, and hanging it off an agent would mean deleting an agent
-- takes a switch's port history with it. Same call `snmp_neighbors` made
-- against `lldp_neighbors`, for the same reason: two id namespaces in one
-- column does not throw, it draws the wrong network.
--
-- WHY THE IDENTITY IS THE NAME AND NOT ifIndex.
--
-- ifIndex is only guaranteed stable between re-initialisations of the network
-- management system. A reboot may renumber; inserting a module into a chassis
-- almost always renumbers everything after it. Key a time series on ifIndex and
-- the 18th's numbers for Gi1/0/12 sit beside the 19th's for a Gi1/0/12 that is
-- now a different physical port — and nothing about the data says so.
--
-- So: UNIQUE (device_id, if_name). The name describes a physical position in
-- the chassis and survives both. `if_index` is a mutable ATTRIBUTE of the row,
-- and `if_index_changed_at` records when it last moved, because the poll that
-- notices the move is also the poll whose counter delta is meaningless.
--
-- `name_source` says WHICH oid the name came from. Not every switch implements
-- ifName; some only have ifDescr, which is less stable. Storing the fallback
-- that was used means a shaky identity is visible rather than assumed — the
-- same rule fdb_entries follows by keeping both the bridge port the device said
-- and the ifIndex it was resolved to.
--
-- This table is INVENTORY, not telemetry: one row per port, changed only when
-- somebody plugs in a module or renames a port. 20 switches x 48 ports is 960
-- rows. It stays in MySQL (docs/storage-split-audit.md); the counters that
-- reference it are the time series, and they are a separate story.
CREATE TABLE IF NOT EXISTS `device_interfaces` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  -- The stable identity. ifName where the device has one, else ifDescr.
  `if_name` VARCHAR(190) NOT NULL,
  `name_source` ENUM('ifName', 'ifDescr', 'ifIndex') NOT NULL DEFAULT 'ifName',
  -- The volatile one. NULL is possible: a row can outlive the index it had.
  `if_index` INT UNSIGNED NULL DEFAULT NULL,
  `if_index_changed_at` DATETIME NULL DEFAULT NULL,
  -- ifAlias is the description a network engineer typed ("uplink to core"), and
  -- it is frequently the only human-readable thing about a port.
  `if_alias` VARCHAR(255) NULL DEFAULT NULL,
  `if_descr` VARCHAR(255) NULL DEFAULT NULL,
  `if_type` INT UNSIGNED NULL DEFAULT NULL,
  `speed_mbps` INT UNSIGNED NULL DEFAULT NULL,
  -- Both statuses, because they answer different questions: somebody turned
  -- this port off, versus this port fell over. NULL means the device did not
  -- say, which is not the same as 'down'.
  `admin_status` VARCHAR(16) NULL DEFAULT NULL,
  `oper_status` VARCHAR(16) NULL DEFAULT NULL,
  `phys_address` CHAR(17) NULL DEFAULT NULL,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device_ifname` (`device_id`, `if_name`),
  KEY `idx_devif_device_index` (`device_id`, `if_index`),
  KEY `idx_devif_last_seen` (`last_seen`),
  CONSTRAINT `fk_devif_device` FOREIGN KEY (`device_id`) REFERENCES `snmp_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
