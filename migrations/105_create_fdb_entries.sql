-- 105 — fdb_entries: which switch port a MAC address is on.
--
-- THE QUESTION THIS ANSWERS. "The printer on the second floor is offline" ends,
-- eventually, at a physical port on a physical switch. Until now BlueEyes could
-- get as far as IP↔MAC (arp_entries, migration 073) and stop: an agent's
-- neighbour cache knows that 192.168.20.84 is 00:1b:44:11:3a:b7, and nothing
-- knew that 00:1b:44:11:3a:b7 is on sw-acc-2 Gi0/14. That last hop is the one
-- that sends somebody to the right patch panel.
--
-- BRIDGE PORT IS NOT ifIndex. This is the detail the whole table rests on.
-- dot1qTpFdbPort/dot1dTpFdbPort give a BRIDGE PORT NUMBER, which is an index
-- into dot1dBasePortTable — not the ifIndex that names the interface. On plenty
-- of switches they happen to coincide for the first few ports and then diverge,
-- which is worse than never matching, because it produces an answer that is
-- right in the lab and wrong in the building. So the agent walks
-- dot1dBasePortIfIndex and resolves the mapping BEFORE reporting, and both
-- numbers are stored: `bridge_port` as the device said it, `if_index` and
-- `if_name` as resolved. When the resolution fails, if_index/if_name are NULL
-- and the row still records where it came from, rather than inventing a port.
--
-- WHY VLAN IS IN THE PRIMARY KEY. Q-BRIDGE learns per VLAN. The same MAC can
-- legitimately appear in two VLANs on the same switch (a router sub-interface,
-- a device on a voice and a data VLAN), and folding those into one row would
-- silently discard a real observation. Devices that only implement the older
-- BRIDGE-MIB report no VLAN; those rows use vlan 0, which is not a real VLAN id
-- and is therefore unambiguous as "the device did not say".
--
-- AGEING, NOT HISTORY. A forwarding table is a snapshot of a moment. Rows are
-- upserted on last_seen and aged out by retention; there is no history table,
-- because "where was this MAC three weeks ago" is a question a forwarding
-- database cannot honestly answer — the entry ages out of the SWITCH in minutes.
-- What matters for search is first_seen/last_seen, so a stale answer is
-- visibly stale rather than confidently wrong. Same rule arp_entries follows.
CREATE TABLE IF NOT EXISTS `fdb_entries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  -- Normalised through the SAME function the ARP ingest uses, so the five
  -- spellings of a MAC resolve identically across both identity sources.
  `mac` CHAR(17) NOT NULL,
  -- 0 = the device reported no VLAN (BRIDGE-MIB only). Never a real VLAN id.
  `vlan` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `bridge_port` INT UNSIGNED NOT NULL,
  `if_index` INT UNSIGNED NULL DEFAULT NULL,
  `if_name` VARCHAR(64) NULL DEFAULT NULL,
  -- 'learned' | 'self' | 'static' | 'mgmt' | 'other', from dot1qTpFdbStatus.
  -- A 'self' entry is the switch's own MAC and must never be reported as "a
  -- device is plugged in here".
  `status` VARCHAR(16) NOT NULL DEFAULT 'learned',
  -- How many MACs the agent saw on this port in the same sweep. THE field that
  -- turns a hit into an answer: one MAC means an end device and a patch panel
  -- to walk to; forty means an uplink and one more hop to go.
  `port_mac_count` INT UNSIGNED NOT NULL DEFAULT 1,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fdb_device_vlan_mac` (`device_id`, `vlan`, `mac`),
  -- The search path: "where is this MAC", fleet-wide, freshest first.
  KEY `idx_fdb_mac` (`mac`, `last_seen`),
  -- "what is on this port" and the per-device table view.
  KEY `idx_fdb_device_port` (`device_id`, `bridge_port`),
  -- Retention ages by last_seen.
  KEY `idx_fdb_last_seen` (`last_seen`),
  CONSTRAINT `fk_fdb_device` FOREIGN KEY (`device_id`) REFERENCES `snmp_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
