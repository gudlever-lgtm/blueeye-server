-- 133 — a switch's own events, its own name, and a counter that was cleared.
--
-- DEVICE EVENTS NAME THE SWITCH THAT SENT THEM. `device_events.device_id` is an
-- AGENT id by design (103: the sender is resolved through the agents' own
-- addresses, and the device log, the target timeline and the changes feed all
-- read it that way). A syslog line or a trap from a polled SWITCH had nowhere
-- to go but that column, and the ARP fallback filled it with the agent that
-- had merely SEEN the switch's address — so a whole switch's log landed on the
-- collector host's timeline. `snmp_device_id` is the switch the event came from,
-- resolved from the sender address against snmp_devices.host; `device_id` keeps
-- its meaning and stays NULL for a switch that is not also an agent. No foreign
-- key, for the reason 103 gives: this is telemetry, bound for a hypertable.
-- The index backs the per-switch device log ("everything sw-core-1 said").
--
-- sysName ON THE DEVICE. The agent reads SNMPv2-MIB sysName on every topology
-- poll and sends it (PROTOCOL.md, snmp-topology) — and the server dropped it.
-- It is the name the switch announces to its neighbours in LLDP and CDP, so
-- without it a neighbour row naming "sw-core-1" could not be matched to the
-- polled switch an admin registered as 10.0.0.2 / "Core". COALESCEd on ingest
-- like sys_descr (116): an older agent that does not send it never erases it.
--
-- 'counter_reset' AS A DISCONTINUITY. A 64-bit counter that went DOWN while
-- the device's uptime went up is neither a reboot nor a wrap — it is somebody
-- running `clear counters`. The rate was already dropped; the row said nothing
-- about why, which is the one thing a NULL rate must never do (109). Adding an
-- ENUM member at the END is an in-place metadata change in MySQL 8, and the
-- MODIFY restates the whole definition, so re-running it is a no-op.
--
-- EVERY STEP IS GUARDED or idempotent so a re-run is a no-op (see 116).

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'device_events'
                      AND column_name = 'snmp_device_id'),
  'DO 0',
  'ALTER TABLE device_events ADD COLUMN snmp_device_id INT UNSIGNED NULL DEFAULT NULL AFTER device_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'device_events'
                      AND index_name = 'idx_device_events_snmp_device'),
  'DO 0',
  'CREATE INDEX idx_device_events_snmp_device ON device_events (snmp_device_id, received_at)');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_devices'
                      AND column_name = 'sys_name'),
  'DO 0',
  'ALTER TABLE snmp_devices ADD COLUMN sys_name VARCHAR(255) NULL DEFAULT NULL AFTER sys_descr');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

ALTER TABLE device_counter_samples
  MODIFY COLUMN `discontinuity` ENUM('first', 'reboot', 'renumber', 'gap', 'wrap', 'counter_reset') NULL DEFAULT NULL;
