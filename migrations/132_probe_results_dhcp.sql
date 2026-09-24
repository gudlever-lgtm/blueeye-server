-- 132 — what the DHCP test heard.
--
-- blueeye-agent gained an active DHCP probe (`type: 'dhcp'`): it broadcasts a
-- DHCPDISCOVER and collects every DHCPOFFER that answers it, without ever
-- sending a DHCPREQUEST — so no lease is taken. One nullable column holds the
-- result, the same way `mtu` (096), `sizes` (097) and `tls`/`rdns` (101) belong
-- to one probe each; every other probe type leaves it NULL.
--
--   { "iface": "eth0", "timeoutMs": 3000, "serverCount": 2,
--     "offers": [ { "serverId": "192.168.1.1", "offeredIp": "192.168.1.100",
--                   "leaseSec": 86400, "router": "192.168.1.1",
--                   "dns": ["192.168.1.1"], "subnetMask": "255.255.255.0",
--                   "relay": null }, … ] }
--
-- `serverCount` is the number the rogue-server finding is decided on: more than
-- one distinct server identifier answering one DISCOVER. `relay` (giaddr) says
-- an offer came through a relay agent, i.e. the answering server is not on the
-- segment at all.
--
-- NULL means "not measured" — a row from before this migration, any other
-- probe type, or a DHCP test that could not run (no permission for port 68).
-- An EMPTY `offers` list is different: the test ran and nobody answered.
--
-- `dhcp` is also added to DIAGNOSTIC_TYPES in probeResultsRepository.js: a
-- missing DHCP server is a real fault with its own finding, but the agent that
-- found it is reachable, and it must not move that agent's uptime or fleet
-- health verdict.

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'probe_results'
                      AND column_name = 'dhcp'),
  'DO 0',
  'ALTER TABLE probe_results ADD COLUMN dhcp JSON NULL DEFAULT NULL AFTER resolver');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
