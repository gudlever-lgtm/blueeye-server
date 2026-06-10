-- 032 — curl content-check fields. The agent's `curl` probe verifies received
-- traffic (not just a connection): HTTP status, response body match, byte count
-- and a response header. It reports the received body size and content-type as
-- metadata — never the body itself. Nullable + backward-compatible: existing
-- ping/tcp/dns/traceroute/http rows simply leave these NULL; the pass/fail
-- explanation rides on the existing `detail` column.
ALTER TABLE probe_results
  ADD COLUMN bytes BIGINT NULL DEFAULT NULL AFTER cert_expiry_days,
  ADD COLUMN content_type VARCHAR(120) NULL DEFAULT NULL AFTER bytes;
