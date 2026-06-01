-- 010 — geo-enriched flow records. One row per reported flow. The external
-- (public) peer is geolocated to country + ASN; purely-internal flows (RFC1918
-- on both ends) are stored with internal=1 and are never geolocated.
CREATE TABLE IF NOT EXISTS flow_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  ts DATETIME NOT NULL,
  src_ip VARCHAR(45) NULL DEFAULT NULL,
  dst_ip VARCHAR(45) NULL DEFAULT NULL,
  ext_ip VARCHAR(45) NULL DEFAULT NULL,
  direction ENUM('in', 'out') NULL DEFAULT NULL,
  proto VARCHAR(16) NULL DEFAULT NULL,
  src_port INT NULL DEFAULT NULL,
  dst_port INT NULL DEFAULT NULL,
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  packets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  flows INT UNSIGNED NOT NULL DEFAULT 0,
  internal TINYINT(1) NOT NULL DEFAULT 0,
  country CHAR(2) NULL DEFAULT NULL,
  asn INT UNSIGNED NULL DEFAULT NULL,
  asn_name VARCHAR(255) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_flows_agent_ts (agent_id, ts),
  KEY idx_flows_country_ts (country, ts),
  KEY idx_flows_asn_ts (asn, ts),
  KEY idx_flows_ts (ts),
  CONSTRAINT fk_flows_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
