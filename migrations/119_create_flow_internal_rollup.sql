-- 120 — a long-term rollup for INTERNAL flows (LAN / OT conversations).
--
-- WHY. The retention job rolls raw flow_records older than RETENTION_RAW_DAYS
-- (7) into flow_rollup and then deletes them. flow_rollup is keyed on the
-- external peer's country + ASN, which an RFC1918 peer never has (private
-- addresses are never geolocated), so every internal conversation was simply
-- deleted after a week with nothing kept. On an OT network that is the traffic
-- that matters: "the SCADA server polls these PLCs on 502" had no history past
-- seven days and no baseline to compare today against.
--
-- ONE ROW per hour bucket x agent x (src_ip, dst_ip, proto, service_port). The
-- service port is the SERVER end of the conversation (a named well-known port
-- if either end has one, else the lower port — src/flows/services.js
-- servicePortOf), so a request and its reply land on the same row and client
-- ephemeral ports never become keys.
--
-- BOUNDED. Per agent per bucket only the top N keys by bytes get their own row
-- (RETENTION_INTERNAL_ROLLUP_TOP_N, default 500); the rest fold into one
-- overflow row with src_ip = dst_ip = '*', proto = '' and service_port = 0,
-- so totals still add up and a port scan cannot blow the table up. Rows expire
-- with the other rollups (RETENTION_ROLLUP_DAYS, default 90).
--
-- Metadata only, like flow_records: addresses, protocol, port, counts. No
-- payload. The unique key is what the rollup's ON DUPLICATE KEY UPDATE sums
-- into, so a re-run of the same bucket can never double a row.
CREATE TABLE IF NOT EXISTS flow_internal_rollup (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bucket DATETIME NOT NULL,
  agent_id INT UNSIGNED NOT NULL,
  src_ip VARCHAR(45) NOT NULL,
  dst_ip VARCHAR(45) NOT NULL,
  proto VARCHAR(16) NOT NULL DEFAULT '',
  service_port INT UNSIGNED NOT NULL DEFAULT 0,
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  packets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  flow_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_flow_internal_rollup (agent_id, bucket, src_ip, dst_ip, proto, service_port),
  -- The purge (bucket < cutoff) and "this pair over the last 90 days".
  KEY idx_flow_internal_rollup_bucket (bucket),
  KEY idx_flow_internal_rollup_pair (src_ip, dst_ip, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
