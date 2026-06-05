-- 019 — HTTP/TLS probe fields. The agent's http(s) synthetic probe reports the
-- final HTTP status code and, for https targets, the TLS certificate's
-- days-to-expiry — so reachability checks and certificate-expiry alerting work
-- off the same probe_results table. Nullable + backward-compatible: existing
-- ping/tcp/dns/traceroute rows simply leave these NULL.
ALTER TABLE probe_results
  ADD COLUMN status SMALLINT NULL DEFAULT NULL AFTER loss_pct,
  ADD COLUMN cert_expiry_days INT NULL DEFAULT NULL AFTER status;
