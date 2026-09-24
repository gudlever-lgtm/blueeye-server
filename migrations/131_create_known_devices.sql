-- 131 — known_devices: the new-device detector's long memory.
--
-- THE GAP THIS CLOSES. The detector (src/discovery/newDeviceDetector.js) calls
-- a MAC new when no ARP table at the site holds it. But arp_entries (073) ages
-- out after 30 days (RETENTION_ARP_DAYS) — correctly, a stale answer to "where
-- is this MAC" is worse than none — so a laptop back from a month's holiday, or
-- a spare PLC powered up for the quarterly test, was "a device we have never
-- seen before" and paged somebody. Seen-before is a much longer question than
-- where-is-it-now, so it gets its own table.
--
-- ONE ROW PER (scope, MAC). `scope` is where "known" applies, exactly the
-- detector's rule: 'site:<locations.id>' for an agent with a site, else
-- 'agent:<agents.id>'. A string rather than two nullable ids because a UNIQUE
-- key over NULLable columns does not deduplicate in MySQL. first_seen is kept,
-- last_seen and last_ip move on every sighting.
--
-- 400 DAYS on last_seen (RETENTION_KNOWN_DEVICE_DAYS), the same horizon as the
-- probe history: long enough that a device used once a year is still known
-- when it comes back, short enough that the table forgets hardware that left.
-- No foreign keys on purpose — the memory outlives a deleted agent or site the
-- same way the finding it prevents would have.
--
-- PRIVACY: a MAC, an IP and two timestamps. Metadata only.
CREATE TABLE IF NOT EXISTS `known_devices` (
  `scope` VARCHAR(32) NOT NULL,
  `mac` CHAR(17) NOT NULL,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  `last_ip` VARCHAR(45) NULL DEFAULT NULL,
  PRIMARY KEY (`scope`, `mac`),
  KEY `idx_known_devices_last_seen` (`last_seen`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed from what the ARP tables hold today, so the memory starts with the last
-- 30 days instead of empty. INSERT IGNORE: re-running the migration never
-- overwrites a row the detector has kept since.
INSERT IGNORE INTO `known_devices` (`scope`, `mac`, `first_seen`, `last_seen`, `last_ip`)
SELECT CASE WHEN g.location_id IS NULL THEN CONCAT('agent:', a.agent_id) ELSE CONCAT('site:', g.location_id) END AS scope_key,
       a.mac, MIN(a.first_seen), MAX(a.last_seen), MAX(a.ip)
  FROM arp_entries a
  JOIN agents g ON g.id = a.agent_id
 GROUP BY scope_key, a.mac;
