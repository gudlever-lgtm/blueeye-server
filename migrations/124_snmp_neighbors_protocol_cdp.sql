-- 124 — snmp_neighbors carries CDP beside LLDP, and says which protocol a row
-- came from.
--
-- WHY CDP AT ALL. Plenty of Cisco estates never turned LLDP on: CDP is on by
-- default and LLDP is not, so the switch-seen neighbour table (106) was empty
-- on exactly the networks where the topology mattered most. The agent now
-- walks CISCO-CDP-MIB cdpCacheTable as well and reports the rows in the same
-- list, tagged `protocol`.
--
-- WHY THE SAME TABLE. Every consumer of switch-seen neighbours — the topology
-- graph and blast radius, the coverage report, the port-history "was this an
-- uplink" question and the neighbour diff — asks "what is on the other end of
-- this port", and a CDP answer is as good as an LLDP one. A second table would
-- have meant teaching all of them to read two.
--
-- WHY `protocol` IS IN THE UNIQUE KEY. A Cisco neighbour running both
-- protocols is reported twice, and the two rows can carry the SAME chassis id
-- and port (LLDP chassis subtype 7 is often the hostname, which is also the CDP
-- device id). Without the protocol in the key the two would overwrite each
-- other on every poll and the row would flip between them. The new key is
-- created FIRST and the old one dropped after it, so there is never a moment
-- without one; every existing row is 'lldp', so the new key holds on them.
--
-- `remote_address` is CDP's cdpCacheAddress — the neighbour's management IP,
-- which is what lets the graph recognise a polled switch by the address it is
-- polled at. `remote_platform` is cdpCachePlatform ("cisco WS-C3850-48P").
-- Both NULL for LLDP rows.
--
-- EVERY STEP IS GUARDED so a re-run is a no-op (see 116).

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_neighbors'
                      AND column_name = 'protocol'),
  'DO 0',
  'ALTER TABLE snmp_neighbors ADD COLUMN protocol VARCHAR(8) NOT NULL DEFAULT ''lldp'' AFTER device_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_neighbors'
                      AND column_name = 'remote_address'),
  'DO 0',
  'ALTER TABLE snmp_neighbors ADD COLUMN remote_address VARCHAR(45) NULL DEFAULT NULL AFTER remote_sys_name');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_neighbors'
                      AND column_name = 'remote_platform'),
  'DO 0',
  'ALTER TABLE snmp_neighbors ADD COLUMN remote_platform VARCHAR(255) NULL DEFAULT NULL AFTER remote_address');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_neighbors'
                      AND index_name = 'uq_snmp_neighbors_proto'),
  'DO 0',
  'CREATE UNIQUE INDEX uq_snmp_neighbors_proto ON snmp_neighbors (device_id, protocol, remote_chassis_id, remote_port_id)');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                    WHERE table_schema = DATABASE() AND table_name = 'snmp_neighbors'
                      AND index_name = 'uq_snmp_neighbors'),
  'ALTER TABLE snmp_neighbors DROP INDEX uq_snmp_neighbors',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
