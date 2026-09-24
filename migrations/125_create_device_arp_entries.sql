-- 125 — device_arp_entries: the ARP table of a polled router or L3 switch.
--
-- THE GAP THIS CLOSES. arp_entries (073) is what an AGENT's own neighbour
-- cache sees — the hosts on the agent's segment. In a flat OT network the
-- agent sits on one segment and the PLCs on others, and the only thing that
-- sees every one of them is the router between them. Its IP-MIB neighbour
-- table (ipNetToPhysicalTable, or the older ipNetToMediaTable) is read by the
-- SNMP topology poll now (collect 'arp') and stored here.
--
-- WHY NOT arp_entries. That table keys on an `agents` id and carries an ENUM
-- source; a polled device has its own id sequence (snmp_devices, 104), and
-- writing a device id into agent_id would attribute a router's table to
-- whichever agent shared the number — the same collision 106 refused for LLDP.
--
-- SAME SHAPE, SAME RULES as arp_entries: one row per (device, ip), a MAC that
-- changes behind an address is an UPDATE stamped in mac_changed_at rather
-- than a second row, and rows age out on last_seen (30 days, the same
-- RETENTION_ARP_DAYS window). `if_index`/`if_name` are the SVI or routed port
-- the address was learned on ("Vlan20") — the name resolved by the agent from
-- the device's own ifName, NULL rather than invented.
--
-- It is an IDENTITY SOURCE: universal search answers IP↔MAC from it, and the
-- new-device detector watches it per site (snmp_devices.location_id).
--
-- PRIVACY: an address pairing the router already holds. Metadata only.
CREATE TABLE IF NOT EXISTS `device_arp_entries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  `ip` VARCHAR(45) NOT NULL,
  `mac` CHAR(17) NOT NULL,
  `if_index` INT UNSIGNED NULL DEFAULT NULL,
  `if_name` VARCHAR(64) NULL DEFAULT NULL,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  `mac_changed_at` DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device_arp` (`device_id`, `ip`),
  KEY `idx_device_arp_mac` (`mac`),
  KEY `idx_device_arp_ip` (`ip`),
  KEY `idx_device_arp_last_seen` (`last_seen`),
  CONSTRAINT `fk_device_arp_device` FOREIGN KEY (`device_id`) REFERENCES `snmp_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
