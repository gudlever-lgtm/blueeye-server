-- 104 — snmp_devices: the switches an agent polls ON BEHALF OF the server.
--
-- WHAT THIS BREAKS, AND WHY IT HAD TO BREAK.
--
-- SNMP already existed here, bound 1:1. `agents.monitor_config.source = 'snmp'`
-- makes the WHOLE agent poll one remote device instead of its own /proc, so a
-- site with twelve switches needed twelve agents. And `insertSnmpDevice()`
-- (agentsRepository) creates an `agents` row with the sentinel platform 'snmp'
-- when an admin promotes a discovered candidate — a row nothing ever polls.
--
-- This table breaks the binding: one agent polls MANY devices, ALONGSIDE its own
-- traffic sampling. `monitor_config` is untouched, so every agent in the field
-- keeps working exactly as before; an agent too old to understand `snmpTargets`
-- ignores an unknown config key, which is the contract we already rely on.
--
-- WHY IT IS NOT AN `agents` ROW. A polled switch is not an agent: it has no
-- token, no WebSocket, no version, no heartbeat, and no self-update. Modelling
-- it as one means every fleet-health rollup, every "agents behind" badge and
-- every licence seat count has to learn to exclude it — and each of those is a
-- place to get it wrong later. `agent_id` here says WHO POLLS IT, which is a
-- different fact.
--
-- WHY THE COMMUNITY STRING IS AES-256-GCM AT REST. An SNMPv2c community is a
-- password in clear text on the wire; that is the protocol's fault and we cannot
-- fix it. What we can refuse to do is keep it readable in the database or hand
-- it back on a GET. Same secretBox treatment as `cmdb_config` and
-- `integrations`, decrypted only when the config is handed to the agent over the
-- already-authenticated channel.
--
-- SSRF. `host` is validated against the Service Assurance host policy on write
-- AND again before a poll is dispatched — the same two-check rule, because a
-- row written before an allowlist narrowed must not keep reaching a target the
-- policy now refuses.
CREATE TABLE IF NOT EXISTS `snmp_devices` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- The agent that reaches this device. Deleting the agent leaves the device
  -- UNASSIGNED rather than deleting it: the inventory entry (and its polled
  -- history) outlives whichever host happened to be polling it, and an admin
  -- reassigns it. ON DELETE SET NULL, so the column is nullable.
  `agent_id` INT UNSIGNED NULL DEFAULT NULL,
  `host` VARCHAR(255) NOT NULL,
  `port` SMALLINT UNSIGNED NOT NULL DEFAULT 161,
  `version` ENUM('1', '2c') NOT NULL DEFAULT '2c',
  -- secretBox token (AES-256-GCM). Never returned by the API.
  `community_encrypted` TEXT NULL DEFAULT NULL,
  `display_name` VARCHAR(255) NULL DEFAULT NULL,
  `location_id` INT UNSIGNED NULL DEFAULT NULL,
  -- What to collect, as a JSON array: ["if","fdb","lldp","vlan"]. A list rather
  -- than four booleans because the agent receives it verbatim and a device that
  -- gains a capability should not need a migration.
  `collect` JSON NULL DEFAULT NULL,
  -- FDB moves slowly and a full bridge-table walk is the expensive call on this
  -- path, so its cadence is per-device and far longer than the traffic sample.
  `interval_sec` INT UNSIGNED NOT NULL DEFAULT 300,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  -- Observed state, written by the ingest. `last_error` is kept as TEXT rather
  -- than a boolean because "timeout" and "no such OID" send a technician to two
  -- different places.
  `last_polled_at` DATETIME NULL DEFAULT NULL,
  `last_ok_at` DATETIME NULL DEFAULT NULL,
  `last_error` VARCHAR(255) NULL DEFAULT NULL,
  -- What the device actually answered on, so the UI can say "fdb not supported"
  -- instead of showing an empty column. JSON array, same vocabulary as
  -- `collect`. Absent is not the same as none — see the note in 105.
  `supported` JSON NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- One row per address per port. Two admins adding the same switch twice would
  -- otherwise double every poll and split its history.
  UNIQUE KEY `uq_snmp_devices_host` (`host`, `port`),
  KEY `idx_snmp_devices_agent` (`agent_id`, `enabled`),
  CONSTRAINT `fk_snmp_devices_agent` FOREIGN KEY (`agent_id`) REFERENCES `agents` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_snmp_devices_location` FOREIGN KEY (`location_id`) REFERENCES `locations` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
