-- 121 — WHY a probe failed, not only that it did.
--
-- Until now a failed DNS or TCP probe reached the server as `ok = 0` plus a loss
-- percentage, and the reason was thrown away in the agent. That made three very
-- different faults read identically in a finding:
--
--   DNS  ENOTFOUND   the resolver ANSWERED: the name does not exist (NXDOMAIN)
--        ETIMEOUT    the resolver did not answer at all
--        ESERVFAIL   it answered, and the answer was "I could not resolve it"
--   TCP  refused     a RST came back — the host is up, nothing listens or an
--                    ACL rejects it
--        timeout     nothing came back — a filter drops it silently, or the
--                    host is gone
--
-- Each has a different owner (the zone, the resolver, the firewall, the
-- service), so the finding has to be able to say which one it was.
--
-- `error_code`  the resolver/socket errno, verbatim (ENOTFOUND, ETIMEOUT,
--               ESERVFAIL, ECONNREFUSED, EHOSTUNREACH, …). Kept as the
--               platform names it because a paraphrase loses precision.
-- `failure`     the TCP probe's own classification of a failed connect:
--               'refused' | 'timeout' | 'unreachable' | 'error'.
-- `resolver`    the resolver a DNS probe asked, when the agent knows it.
--
-- All three are nullable and NULL on every row an older agent wrote (and on
-- every successful one): absent means "not reported", never "nothing wrong".
--
-- The per-hop `ips` list a trace now carries (every responding address at one
-- TTL, for ECMP) needs no column: it rides inside the existing `hops` JSON.

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'probe_results'
                      AND column_name = 'error_code'),
  'DO 0',
  'ALTER TABLE probe_results ADD COLUMN error_code VARCHAR(32) NULL DEFAULT NULL AFTER rdns');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'probe_results'
                      AND column_name = 'failure'),
  'DO 0',
  'ALTER TABLE probe_results ADD COLUMN failure VARCHAR(16) NULL DEFAULT NULL AFTER error_code');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'probe_results'
                      AND column_name = 'resolver'),
  'DO 0',
  'ALTER TABLE probe_results ADD COLUMN resolver VARCHAR(64) NULL DEFAULT NULL AFTER failure');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
