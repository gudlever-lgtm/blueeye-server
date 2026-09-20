-- 109 — device_counter_samples: interface counters from a polled switch, over time.
--
-- This is the table the whole SNMP effort was building towards. Everything
-- before it answered WHERE something is; this answers what a port has been
-- DOING, and it is the first per-port time series in the product.
--
-- WHY BOTH THE RAW COUNTER AND THE COMPUTED RATE.
--
-- Nothing else here stores a raw counter: snmpMonitor.js reads twice and sends
-- rates, and the counters never leave the agent. That is fine when the agent
-- measures itself at a cadence it owns, and wrong here, because:
--
--   * A rate can never be recomputed. Change the definition of "utilisation"
--     and every historical number is stuck with the old one.
--   * A counter reset cannot be recognised after the fact. With only rates, a
--     reboot shows up as a single enormous spike that is indistinguishable from
--     a real one.
--   * A MISSING cycle cannot be told from a cycle that measured zero. A raw
--     counter that did not move says "no traffic"; a row that is not there says
--     "we did not look".
--
-- So the raw value is the evidence and the rate is the derivation, and both are
-- kept. `discontinuity` is what makes a NULL rate readable rather than
-- suspicious: the device rebooted, or its ifIndex moved, and the delta across
-- that boundary would have been a fabricated number.
--
-- WHY A WIDE ROW (one per port per poll) AND NOT ONE PER METRIC.
--
-- 20 switches x 48 ports x 10 metrics at 60 s is 13.8 million rows a day narrow
-- and 1.38 million wide — a factor of ten. The cost is that a new metric is an
-- ALTER rather than a new id, and with IF-MIB that is acceptable: the column set
-- is defined by an RFC from 2000 and does not move.
--
-- WHY interface_id AND NOT ifIndex.
--
-- ifIndex is only stable between re-initialisations of the network management
-- system. Keyed on it, the 18th's numbers for Gi1/0/12 would sit beside the
-- 19th's for a Gi1/0/12 that is now a different physical port. The samples point
-- at a `device_interfaces` row (migration 108), whose identity is the NAME, so a
-- renumbering moves one column in one inventory row and leaves every historical
-- measurement pointing at the right port.
--
-- STORE: TELEMETRY. This is the second-largest write stream in the product after
-- flow_records, and it belongs in TimescaleDB by the rules in
-- docs/storage-split-audit.md. It is dual-store like device_events and results:
-- MySQL is the fallback when TSDB is not configured, with a SHORTER retention,
-- because 180 bytes x 1.38 million rows a day is 10 GB a month in InnoDB.
--
-- NO FOREIGN KEY on interface_id, for the same reason results and device_events
-- have none: telemetry must not be deleted by a cascade from an inventory row,
-- and the TSDB copy cannot have one at all. The inventory is purged on a LONGER
-- window than these samples (180 days vs 90) so the reference stays resolvable.
CREATE TABLE IF NOT EXISTS `device_counter_samples` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ts` DATETIME(3) NOT NULL,
  `device_id` INT UNSIGNED NOT NULL,
  `interface_id` BIGINT UNSIGNED NOT NULL,

  -- RAW, as the device said them. NULL means the device did not answer for
  -- that column, which is not the same as zero — "zero FCS errors" is what
  -- RULES OUT a bad cable, and a device that cannot count them has ruled out
  -- nothing.
  `in_octets` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_octets` BIGINT UNSIGNED NULL DEFAULT NULL,
  `in_ucast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_ucast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `in_mcast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `in_bcast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_mcast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_bcast_pkts` BIGINT UNSIGNED NULL DEFAULT NULL,
  `in_errors` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_errors` BIGINT UNSIGNED NULL DEFAULT NULL,
  `in_discards` BIGINT UNSIGNED NULL DEFAULT NULL,
  `out_discards` BIGINT UNSIGNED NULL DEFAULT NULL,
  `fcs_errors` BIGINT UNSIGNED NULL DEFAULT NULL,
  `alignment_errors` BIGINT UNSIGNED NULL DEFAULT NULL,
  `late_collisions` BIGINT UNSIGNED NULL DEFAULT NULL,
  `carrier_sense_errors` BIGINT UNSIGNED NULL DEFAULT NULL,

  -- DERIVED for the interval that ended at `ts`. All NULL on the first sample
  -- for a port and on any interval the delta could not be trusted.
  `delta_sec` INT UNSIGNED NULL DEFAULT NULL,
  `in_bps` DOUBLE NULL DEFAULT NULL,
  `out_bps` DOUBLE NULL DEFAULT NULL,
  `in_err_pps` DOUBLE NULL DEFAULT NULL,
  `out_err_pps` DOUBLE NULL DEFAULT NULL,
  `in_disc_pps` DOUBLE NULL DEFAULT NULL,
  `out_disc_pps` DOUBLE NULL DEFAULT NULL,
  `fcs_pps` DOUBLE NULL DEFAULT NULL,
  -- Broadcast arrival rate. Its own column because it is the counter a
  -- forwarding loop moves first, long before anything else notices.
  `in_bcast_pps` DOUBLE NULL DEFAULT NULL,
  -- Percent of the port's speed, both directions taken separately. NULL when
  -- the device did not report a speed: a percentage of an unknown is not a
  -- number, and 0 would read as an idle port.
  `in_util_pct` DOUBLE NULL DEFAULT NULL,
  `out_util_pct` DOUBLE NULL DEFAULT NULL,

  -- WHY THE RATE IS MISSING. 'reboot' — sysUpTime went backwards, or rose by
  -- less than the wall clock did. 'renumber' — the port's ifIndex moved between
  -- polls, so the two readings are different ports. 'first' — no previous
  -- sample. 'gap' — too long since the last one for a rate to mean anything.
  -- NULL means the delta is real.
  `discontinuity` ENUM('first', 'reboot', 'renumber', 'gap', 'wrap') NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_counter_sample` (`interface_id`, `ts`),
  KEY `idx_counter_device_ts` (`device_id`, `ts`),
  KEY `idx_counter_ts` (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The counter cadence is its own setting, because a counter series' interval IS
-- its resolution: a five-minute sample cannot show a two-minute error burst at
-- all, while a five-minute forwarding-table sweep is generous. NULL means the
-- device is not polled for counters, which is also what an empty `collect` says
-- — the volume is opt-in per device.
ALTER TABLE `snmp_devices`
  ADD COLUMN `counter_interval_sec` INT UNSIGNED NULL DEFAULT NULL AFTER `interval_sec`;

-- What the device's own clock said at the last counter poll, and when that poll
-- was. Kept on the DEVICE rather than recomputed from the samples, because the
-- reset check needs the previous reading before the new rows are written and a
-- scan of the time series for it would be a read per device per cycle.
ALTER TABLE `snmp_devices`
  ADD COLUMN `last_uptime_ticks` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `last_error`,
  ADD COLUMN `last_uptime_at` DATETIME(3) NULL DEFAULT NULL AFTER `last_uptime_ticks`;
