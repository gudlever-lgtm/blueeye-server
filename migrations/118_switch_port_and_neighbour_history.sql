-- 118 — switch ports and switch-seen LLDP neighbours get a HISTORY.
--
-- SWITCH PORT LINK STATE. `device_interfaces.oper_status` is overwritten by
-- every topology poll, and a link.down/link.up from a trap or syslog line only
-- ever reached the Device Log. So "Gi1/0/24 on sw-core-1 went down at 02:14 and
-- has bounced nine times since" was not something the product could say, and a
-- switch port that went down produced no finding, no alert and no event case.
--
-- REUSED, NOT A NEW TABLE. `interface_state_transitions` (075) already is the
-- interface history: the changes feed reads it, retention ages it (90 days),
-- and the flap collapse (a reversal inside the window folds onto one row,
-- "flapping 14×") is exactly what a switch port needs too. Two nullable columns
-- say which switch and which port a row is about; `agent_id` keeps meaning
-- "who observed it" — the agent that polls the switch, or that received the
-- trap — so every per-agent read still finds these rows, the same rule
-- findings follow (migration 110). A NULL device_id is an agent's own NIC,
-- exactly as before.
--
-- `interface_states` (the snapshot the agent path diffs against) is NOT reused:
-- a switch port's current state already lives in `device_interfaces`, and a
-- second copy of it would be a second thing to keep in step.
--
-- `source` says how the change was learned: 'poll' (two topology polls
-- disagreed), 'trap' or 'syslog' (the switch said so as it happened). NULL on
-- every row that existed before, which are all agent-observed.
--
-- SWITCH-SEEN LLDP CHANGES. topology_changes (067) was only ever fed by the
-- agent's own LLDP report, which the agent does not send — so the table stayed
-- empty in production while the switches' own LLDP tables (snmp_neighbors, 106)
-- changed underneath it unobserved. The SNMP topology ingest now diffs each
-- polled switch's neighbours against its previous snapshot and writes here;
-- `device_id` names the switch, `agent_id` stays the polling agent.
--
-- No foreign keys on the new columns, matching findings.device_id (110): these
-- are records of moments, and deleting a switch from the inventory must not
-- delete the evidence of what it did. Every step is guarded (see 116).

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'interface_state_transitions'
                      AND column_name = 'device_id'),
  'DO 0',
  'ALTER TABLE interface_state_transitions ADD COLUMN device_id INT UNSIGNED NULL DEFAULT NULL AFTER agent_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'interface_state_transitions'
                      AND column_name = 'interface_id'),
  'DO 0',
  'ALTER TABLE interface_state_transitions ADD COLUMN interface_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER device_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'interface_state_transitions'
                      AND column_name = 'source'),
  'DO 0',
  'ALTER TABLE interface_state_transitions ADD COLUMN source VARCHAR(16) NULL DEFAULT NULL AFTER oper_status');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- The flap lookup for a switch port: its newest transition inside the window.
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'interface_state_transitions'
                      AND index_name = 'idx_iface_trans_device'),
  'DO 0',
  'CREATE INDEX idx_iface_trans_device ON interface_state_transitions (device_id, iface, detected_at)');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'topology_changes'
                      AND column_name = 'device_id'),
  'DO 0',
  'ALTER TABLE topology_changes ADD COLUMN device_id INT UNSIGNED NULL DEFAULT NULL AFTER agent_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- The flap lookup for a switch's neighbour changes.
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'topology_changes'
                      AND index_name = 'idx_topo_changes_device'),
  'DO 0',
  'CREATE INDEX idx_topo_changes_device ON topology_changes (device_id, detected_at)');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
