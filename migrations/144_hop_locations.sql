-- 144 — hop_locations: the server's OWN location table for traceroute hops.
--
-- THE GAP THIS CLOSES. Every position on a path map today is inferred:
-- a router's PTR name, a city GeoIP range, a country centroid
-- (src/geo/hopLocation.js). All three are published by somebody else about an
-- address BLOCK, and a block is registered where the operator's head office is,
-- not where the rack is. So a Copenhagen router comes out in Frankfurt, and the
-- path draws a line across Europe that the reply times say never happened.
-- src/geo/hopConsistency.js can now SEE that — a hop that disagrees with both
-- its neighbours while they agree with each other — but seeing it is only half
-- an answer. This table is the other half: what the operator KNOWS, written
-- down once and used from then on.
--
-- It outranks every GeoIP source (it is the first candidate in locateHop) and
-- is never second-guessed by the consistency check. Somebody who runs the
-- network said where the router is; no range file gets to overrule that.
--
-- ONE ROW PER (ip, prefix_len). A /32 for one router, a shorter prefix for a
-- whole block ("everything in 193.162.153.0/24 is in Copenhagen") — a single
-- correction usually fixes a dozen hops, because an operator numbers one site
-- out of one block. The longest matching prefix wins at lookup, so a /32
-- exception inside a corrected /24 behaves the way an operator expects.
--
-- `source` says where the row came from, and nothing else treats them
-- differently:
--   manual   a person corrected the hop in the UI (Path visualisation →
--            "Correct location"), with their user id in created_by.
--   ripe     imported from a RIPE NCC database dump's `geoloc:` attribute —
--            the coordinates the holder of the block PUBLISHED for it
--            (scripts/import-ripe-geoloc.js). European, offline, and as close
--            to an authoritative statement as address registration gets.
-- A manual row is never overwritten by an import: the importer only inserts.
--
-- PRIVACY. Public router addresses and coordinates — the same class of data the
-- GeoIP range files already hold. RFC1918 addresses are refused by the
-- validator, the way they are never geolocated anywhere else (docs/geo.md).
CREATE TABLE IF NOT EXISTS `hop_locations` (
  -- The network address of the correction, as text (the geo layer is IPv4
  -- today; a column that holds a v6 literal costs nothing and avoids a
  -- migration when it is not).
  `ip` VARCHAR(45) NOT NULL,
  -- 32 = this one address. Shorter = the whole block.
  `prefix_len` TINYINT UNSIGNED NOT NULL DEFAULT 32,
  `latitude` DECIMAL(9, 6) NOT NULL,
  `longitude` DECIMAL(9, 6) NOT NULL,
  -- What to call the place on the map. Both optional: coordinates are the
  -- correction, the name is the label.
  `city` VARCHAR(100) NULL DEFAULT NULL,
  `country` CHAR(2) NULL DEFAULT NULL,
  `source` ENUM('manual', 'ripe') NOT NULL DEFAULT 'manual',
  -- Why — "measured from the Aarhus agent", "operator confirmed". Shown next to
  -- the hop, so the next person does not re-litigate the correction.
  `note` VARCHAR(255) NULL DEFAULT NULL,
  `created_by` INT UNSIGNED NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ip`, `prefix_len`),
  KEY `idx_hop_locations_source` (`source`),
  -- The correction outlives the account that made it: a deleted user must not
  -- take the network's map back to a wrong GeoIP answer.
  CONSTRAINT `fk_hop_locations_user` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
