-- 103 — device_events: what the network equipment itself says.
--
-- Until now the server could see that something broke (anomaly findings, probe
-- outages) but not why. The devices already say why — link flaps, STP topology
-- changes, OSPF adjacency drops, DHCP pool exhaustion — and nothing listened.
-- The agent listens now (blueeye-agent src/syslog/), and this is where what it
-- hears lands.
--
-- ONE TABLE FOR SYSLOG AND TRAPS. `transport` is an ENUM with both values from
-- the start even though only 'syslog' is written today. An SNMP trap and a
-- syslog line are the same thing arriving over a different socket: same sender,
-- same device, same event_type vocabulary, same place on the timeline. Adding
-- the column later would mean a second migration against a table that by then
-- holds millions of rows, and a second ingest path to keep in step with this
-- one. The cost of deciding now is one unused enum value.
--
-- NO FOREIGN KEYS. This is TELEMETRY by the classification in
-- docs/storage-split-audit.md — HIGH write volume, and bound for TimescaleDB
-- when TSDB is enabled (the repository has a MySQL and a TSDB implementation,
-- the same dual-store pattern `results` and `probe_results` use). A hypertable
-- cannot carry an FK into MySQL, so `agent_id` and `device_id` are plain
-- integers here for exactly the reason transaction_results (046) has none.
--
-- WHY device_id IS NULLABLE. The sender is resolved from its IP against
-- arp_entries and the SNMP monitor targets. When that fails — a device nobody
-- has ARPed yet, a relay forwarding on someone else's behalf — the row is still
-- stored, with device_id NULL and source_ip intact. Discarding it would lose
-- the one message that explains an outage because the inventory was incomplete,
-- which is precisely when inventories are incomplete.
--
-- WHY clock_skew_ms IS A COLUMN. Switches keep bad time. A device whose clock
-- is three seconds behind silently ruins every correlation built on its
-- timestamps, and an operator reading the log has no way to tell. Storing the
-- measured difference between the device's own stamp and the moment the agent
-- received the line puts that failure on the screen instead of inside the data.
-- NULL means the line carried no device time at all, which is not zero skew.
--
-- DEDUP. `dedup_key` is nullable + UNIQUE, the same mechanism audit_events (035)
-- uses to fold recurring activity onto one row. The key the ingest builds
-- INCLUDES A TIME BUCKET, so folding is bounded to a window: a link flap today
-- never merges into one from last week, and a rate that changes over time stays
-- visible as separate rows. NULL opts a row out of folding entirely.
CREATE TABLE IF NOT EXISTS `device_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- The agent that RECEIVED the message (always known — it authenticated).
  `agent_id` INT UNSIGNED NOT NULL,
  -- The device that SENT it, once resolved. NULL when it could not be.
  `device_id` INT UNSIGNED NULL DEFAULT NULL,
  -- 45 chars holds an IPv4-mapped IPv6 literal in full.
  `source_ip` VARCHAR(45) NOT NULL,
  `received_at` DATETIME(3) NOT NULL,
  `device_time` DATETIME(3) NULL DEFAULT NULL,
  `clock_skew_ms` INT NULL DEFAULT NULL,
  `transport` ENUM('syslog', 'trap') NOT NULL DEFAULT 'syslog',
  -- Syslog facility 0-23 and severity 0-7, kept NUMERIC. The names are a
  -- presentation concern and belong in the UI catalogue, not in the row.
  `facility` TINYINT UNSIGNED NULL DEFAULT NULL,
  `severity` TINYINT UNSIGNED NOT NULL,
  -- The classified fault ('link.down', 'ospf.adjacency_lost', …) or
  -- 'syslog.raw' when the agent did not recognise it. Never a guess.
  `event_type` VARCHAR(64) NOT NULL DEFAULT 'syslog.raw',
  -- The device's own hostname as IT spelled it, which is not necessarily the
  -- hostname the inventory knows it by — both are worth having.
  `device_hostname` VARCHAR(255) NULL DEFAULT NULL,
  `tag` VARCHAR(64) NULL DEFAULT NULL,
  `ifname` VARCHAR(64) NULL DEFAULT NULL,
  `summary` VARCHAR(512) NOT NULL,
  -- The line as received, credentials already masked by the agent, capped at
  -- 2 KB there. TEXT rather than VARCHAR so the row stays narrow.
  `raw` TEXT NULL DEFAULT NULL,
  `detail` JSON NULL DEFAULT NULL,
  `dedup_key` VARCHAR(160) NULL DEFAULT NULL,
  `occurrences` INT UNSIGNED NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device_events_dedup` (`dedup_key`),
  -- The device log screen's default read: newest first, whole fleet.
  KEY `idx_device_events_received` (`received_at`),
  -- One device's history, and the join the target timeline makes.
  KEY `idx_device_events_device` (`device_id`, `received_at`),
  -- "show me every link.down in the last hour" across the fleet.
  KEY `idx_device_events_type` (`event_type`, `received_at`),
  -- The severity filter on the log screen, which is how an operator gets from
  -- 4 000 notices to the 6 lines that matter.
  KEY `idx_device_events_severity` (`severity`, `received_at`),
  -- Retention purges by age; kept separate from the read indexes above so a
  -- nightly delete does not depend on one of them staying leftmost.
  KEY `idx_device_events_agent` (`agent_id`, `received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
