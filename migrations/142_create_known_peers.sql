-- 142 — known_peers: which external networks a site has EVER talked to.
--
-- THE GAP THIS CLOSES. Everything in the analysis module is a comparison
-- against a number that moved: a z-score, a threshold, a rate. None of it can
-- express the oldest question in incident response — "has this ever happened
-- before?" — because nothing recorded what had. flow_records carries the ASN
-- and the country of every external endpoint, and is kept ~7 days; the geo
-- screens read it and colour a map. When the retention job deletes the row,
-- the fact that the site once talked to AS12345 is gone with it, so "a server
-- that has never had outbound traffic just started talking to a network in
-- another country" was unexpressible. This table is that memory.
--
-- It is the same idea as known_devices (131), one layer out: that table
-- remembers every MAC a site has had, this one remembers every external
-- network it has reached. Deliberately the same shape, the same scope string
-- and the same 400-day horizon, because it answers the same kind of question
-- and an operator should not have to learn two models.
--
-- ONE ROW PER (scope, peer_kind, peer_key).
--   scope      where "known" applies — 'site:<locations.id>' when the agent has
--              a site, else 'agent:<agents.id>'. A string rather than two
--              nullable ids because a UNIQUE key over NULLable columns does not
--              deduplicate in MySQL. Exactly what knownPeersRepository.scopeKey
--              (shared with known_devices) builds.
--   peer_kind  'asn' or 'country'. Two kinds rather than two tables: they are
--              read together, aged together and purged together, and the
--              detector's question ("is this peer new for this scope") is the
--              same for both.
--   peer_key   the ASN as a decimal string ('15169'), or the ISO-3166 alpha-2
--              country ('RU'). A string for both so one column serves.
--
-- NOT PER INTERNAL HOST, ON PURPOSE. (host -> ASN) would be the sharper
-- signal, and it is also hosts x networks rows and a finding every time a
-- workstation opens a new CDN. The scope is the unit an operator actually
-- reasons about ("nothing at this site has ever talked to that network"), and
-- last_src_ip keeps the address that triggered it, which is what an
-- investigation needs. If per-host memory is ever wanted, it is a third
-- peer_kind, not a second table.
--
-- PRIVACY. An ASN, a country, two addresses and two timestamps — the same
-- metadata flow_records already holds, and nothing that is not already there.
-- RFC1918 addresses are never geolocated (docs/geo.md), so an internal flow
-- has no ASN and never reaches this table.
--
-- 400 DAYS on last_seen (RETENTION_KNOWN_PEER_DAYS), the same horizon as
-- known_devices: long enough that an annual off-site backup target is still
-- known when it comes back, short enough that the table forgets a network the
-- site stopped using. No foreign keys, for the same reason 131 has none — the
-- memory outlives a deleted agent or site the way the finding it prevents
-- would have.
CREATE TABLE IF NOT EXISTS `known_peers` (
  `scope` VARCHAR(32) NOT NULL,
  `peer_kind` ENUM('asn', 'country') NOT NULL,
  `peer_key` VARCHAR(64) NOT NULL,
  -- The AS name as the enrichment spelled it at the last sighting, so a
  -- finding can say "AS15169 (Google LLC)" without a second lookup. NULL for a
  -- country, and for an ASN the GeoIP database had no name for.
  `peer_name` VARCHAR(255) NULL DEFAULT NULL,
  `first_seen` DATETIME NOT NULL,
  `last_seen` DATETIME NOT NULL,
  -- The internal address that last talked to this peer, and the external one it
  -- talked to. Evidence for the finding, not identity: they move on every
  -- sighting and nothing keys on them.
  `last_src_ip` VARCHAR(45) NULL DEFAULT NULL,
  `last_ext_ip` VARCHAR(45) NULL DEFAULT NULL,
  PRIMARY KEY (`scope`, `peer_kind`, `peer_key`),
  KEY `idx_known_peers_last_seen` (`last_seen`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed from the flow records that still exist, so the memory starts with the
-- last ~7 days instead of empty — otherwise the first run of the detector
-- would call every network on the internet new at once. The detector has its
-- own flood guard (a scope is silent until its memory is old enough), but a
-- seeded table is what makes that guard short rather than a week long.
--
-- INSERT IGNORE: re-running the migration never overwrites a row the detector
-- has kept since. Runs on every deploy (migrations are re-runnable), and after
-- the first one every peer it would insert is already there.
INSERT IGNORE INTO known_peers (scope, peer_kind, peer_key, peer_name, first_seen, last_seen, last_src_ip, last_ext_ip)
SELECT CONCAT(IF(a.location_id IS NULL, 'agent:', 'site:'), COALESCE(a.location_id, a.id)) AS scope,
       'asn' AS peer_kind,
       CAST(f.asn AS CHAR) AS peer_key,
       MAX(f.asn_name) AS peer_name,
       MIN(f.ts) AS first_seen,
       MAX(f.ts) AS last_seen,
       MAX(f.src_ip) AS last_src_ip,
       MAX(f.ext_ip) AS last_ext_ip
FROM flow_records f
JOIN agents a ON a.id = f.agent_id
WHERE f.internal = 0 AND f.asn IS NOT NULL
GROUP BY scope, peer_key;

INSERT IGNORE INTO known_peers (scope, peer_kind, peer_key, peer_name, first_seen, last_seen, last_src_ip, last_ext_ip)
SELECT CONCAT(IF(a.location_id IS NULL, 'agent:', 'site:'), COALESCE(a.location_id, a.id)) AS scope,
       'country' AS peer_kind,
       f.country AS peer_key,
       NULL AS peer_name,
       MIN(f.ts) AS first_seen,
       MAX(f.ts) AS last_seen,
       MAX(f.src_ip) AS last_src_ip,
       MAX(f.ext_ip) AS last_ext_ip
FROM flow_records f
JOIN agents a ON a.id = f.agent_id
WHERE f.internal = 0 AND f.country IS NOT NULL
GROUP BY scope, peer_key;
