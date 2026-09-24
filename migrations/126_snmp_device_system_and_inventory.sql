-- 126 — what a polled device says about WHERE it is and WHAT it is.
--
-- sysLocation / sysContact / sysObjectID (SNMPv2-MIB). The OIDs were in the
-- agent's map and never read. sysLocation is the one that matters: it is the
-- text an admin typed into the switch — "Bygning 3, rum 2.14, rack B" — and the
-- only place the network says where a device is BELOW the site. With it,
-- "which devices do I have and where are they" answers at room/rack level
-- wherever the switch says so. Kept with COALESCE on ingest like sys_descr
-- (116), so an older agent that does not send them never erases them.
--
-- ENTITY-MIB INVENTORY. Two places, deliberately:
--
--   * `device_inventory` — every chassis the device reports (a stack of eight
--     is eight chassis with eight serials, and the RMA is for ONE of them) plus
--     a bounded number of modules that name a model or a serial. Replaced per
--     poll: it is the current state of the box, not history. Searchable by
--     serial through idx_device_inventory_serial.
--   * `hw_*` on snmp_devices — the FIRST chassis's model, serial, vendor and
--     revisions, so the device list, the search result and the coverage report
--     can show "WS-C3850-48P" without a join per row.
--
-- EVERY STEP IS GUARDED so a re-run is a no-op (see 116).

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_devices'
                      AND column_name = 'sys_location'),
  'DO 0',
  'ALTER TABLE snmp_devices ADD COLUMN sys_location VARCHAR(255) NULL DEFAULT NULL AFTER sys_descr');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_devices'
                      AND column_name = 'sys_contact'),
  'DO 0',
  'ALTER TABLE snmp_devices ADD COLUMN sys_contact VARCHAR(255) NULL DEFAULT NULL AFTER sys_location');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_devices'
                      AND column_name = 'sys_object_id'),
  'DO 0',
  'ALTER TABLE snmp_devices ADD COLUMN sys_object_id VARCHAR(128) NULL DEFAULT NULL AFTER sys_contact');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_devices'
                      AND column_name = 'hw_vendor'),
  'DO 0',
  'ALTER TABLE snmp_devices ADD COLUMN hw_vendor VARCHAR(128) NULL DEFAULT NULL AFTER sys_object_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_devices'
                      AND column_name = 'hw_model'),
  'DO 0',
  'ALTER TABLE snmp_devices ADD COLUMN hw_model VARCHAR(128) NULL DEFAULT NULL AFTER hw_vendor');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_devices'
                      AND column_name = 'hw_serial'),
  'DO 0',
  'ALTER TABLE snmp_devices ADD COLUMN hw_serial VARCHAR(64) NULL DEFAULT NULL AFTER hw_model');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_devices'
                      AND column_name = 'hw_rev'),
  'DO 0',
  'ALTER TABLE snmp_devices ADD COLUMN hw_rev VARCHAR(64) NULL DEFAULT NULL AFTER hw_serial');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_devices'
                      AND column_name = 'fw_rev'),
  'DO 0',
  'ALTER TABLE snmp_devices ADD COLUMN fw_rev VARCHAR(64) NULL DEFAULT NULL AFTER hw_rev');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_devices'
                      AND column_name = 'sw_rev'),
  'DO 0',
  'ALTER TABLE snmp_devices ADD COLUMN sw_rev VARCHAR(64) NULL DEFAULT NULL AFTER fw_rev');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- The inventory rows. `ent_index` is entPhysicalIndex, the device's own key
-- for the entity; `ent_class` is 'chassis' or 'module'.
CREATE TABLE IF NOT EXISTS `device_inventory` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  `ent_index` INT UNSIGNED NOT NULL,
  `ent_class` VARCHAR(16) NOT NULL,
  `name` VARCHAR(64) NULL DEFAULT NULL,
  `descr` VARCHAR(255) NULL DEFAULT NULL,
  `model` VARCHAR(128) NULL DEFAULT NULL,
  `serial` VARCHAR(64) NULL DEFAULT NULL,
  `vendor` VARCHAR(128) NULL DEFAULT NULL,
  `hardware_rev` VARCHAR(64) NULL DEFAULT NULL,
  `firmware_rev` VARCHAR(64) NULL DEFAULT NULL,
  `software_rev` VARCHAR(64) NULL DEFAULT NULL,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device_inventory` (`device_id`, `ent_index`),
  KEY `idx_device_inventory_serial` (`serial`),
  CONSTRAINT `fk_device_inventory_device` FOREIGN KEY (`device_id`) REFERENCES `snmp_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
