-- 127 — WHICH VLAN, and which switch ports, a flow crossed.
--
-- sFlow flow samples carry the ingress/egress ifIndex in their header and the
-- 802.1Q tag in the sampled frame; NetFlow v9/IPFIX carry the same things as
-- IEs 10/14 (ingress/egressInterface) and 58/243 (vlanId/dot1qVlanId). The
-- agent decoded all of it and dropped it before the flow was aggregated, so a
-- flow record could say WHO talked to whom but not on which VLAN or through
-- which port of the exporting switch — the first two questions on a trunk.
--
-- `vlan`    the 802.1Q VLAN id, 1..4094 (0 and 4095 are not VLANs).
-- `in_if`   the exporter's ifIndex the traffic entered by.
-- `out_if`  the exporter's ifIndex it left by.
--
-- All three are nullable and NULL on every row an older agent wrote, on every
-- NetFlow v5 record (which has no VLAN) and whenever the exporter did not say:
-- absent means "not reported", never "VLAN 1" or "port 0".
--
-- No index. Nothing reads by VLAN yet, and flow_records is the highest-volume
-- insert path in the product; an index is added with the query that needs it.

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'flow_records'
                      AND column_name = 'vlan'),
  'DO 0',
  'ALTER TABLE flow_records ADD COLUMN vlan SMALLINT UNSIGNED NULL DEFAULT NULL AFTER asn_name');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'flow_records'
                      AND column_name = 'in_if'),
  'DO 0',
  'ALTER TABLE flow_records ADD COLUMN in_if INT UNSIGNED NULL DEFAULT NULL AFTER vlan');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'flow_records'
                      AND column_name = 'out_if'),
  'DO 0',
  'ALTER TABLE flow_records ADD COLUMN out_if INT UNSIGNED NULL DEFAULT NULL AFTER in_if');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
