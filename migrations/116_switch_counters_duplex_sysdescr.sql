-- 116 — what a switch port says about its DUPLEX, the late-collision RATE, and
-- what the switch says it IS.
--
-- DUPLEX WAS VALIDATED AND THROWN AWAY. The agent has read EtherLike-MIB
-- dot3StatsDuplexStatus since the counters landed (migration 109) and the
-- validator has accepted it, but there was no column, so the one fact that
-- turns "this port has FCS errors" into "this port has a DUPLEX MISMATCH" never
-- reached the disk. A half-duplex port with late collisions climbing is the
-- textbook mismatch — one end forced to 100/full, the other autonegotiating to
-- 100/half — and neither the screen nor the detector could say so.
--
-- VARCHAR, not ENUM: the vocabulary is the agent's ('half' | 'full' |
-- 'unknown'), the validator already refuses anything else, and an ENUM change
-- is an ALTER on the second-largest table in the schema. NULL means the device
-- did not answer — which is not the same as 'unknown', where it did.
--
-- LATE COLLISIONS ONLY EXISTED AS A RAW COUNTER. A counter is not something the
-- detector can baseline (it only ever rises), so it was stored and never
-- analysed. `late_coll_pps` is the rate for the interval, computed exactly like
-- `fcs_pps` and voided by the same discontinuities.
--
-- sysDescr ON THE DEVICE. The agent read SNMPv2-MIB sysDescr on every topology
-- poll and dropped it before sending. "Cisco IOS Software, C2960X … 15.2(7)E3"
-- is what tells a technician which switch this is and which firmware it runs
-- without logging in to it. One nullable string; the topology ingest keeps the
-- last one it was told (COALESCE), so an older agent that does not send it never
-- erases one a newer agent did.
--
-- EVERY STEP IS GUARDED so a re-run is a no-op (the container runs
-- `migrate && server`, and an unguarded ADD COLUMN that meets an existing column
-- takes the server down). Same prepared-statement idiom as 076/077.

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'device_counter_samples'
                      AND column_name = 'duplex'),
  'DO 0',
  'ALTER TABLE device_counter_samples ADD COLUMN duplex VARCHAR(8) NULL DEFAULT NULL AFTER carrier_sense_errors');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'device_counter_samples'
                      AND column_name = 'late_coll_pps'),
  'DO 0',
  'ALTER TABLE device_counter_samples ADD COLUMN late_coll_pps DOUBLE NULL DEFAULT NULL AFTER fcs_pps');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_devices'
                      AND column_name = 'sys_descr'),
  'DO 0',
  'ALTER TABLE snmp_devices ADD COLUMN sys_descr VARCHAR(255) NULL DEFAULT NULL AFTER display_name');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
