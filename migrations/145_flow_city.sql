-- 145 — WHERE a destination actually is, when that can be said honestly.
--
-- A flow record is geolocated to country + ASN, and the map draws it on the
-- country centroid. For Canada that is a point in the middle of Nunavut, which
-- is a truthful answer to a question nobody asked: the reader wants to know
-- that the traffic goes to Montreal. A traceroute stop in the same country is
-- drawn on its city, so the two layers of the same map disagree by a thousand
-- kilometres and the reader is left to work out why.
--
-- City GeoIP can answer it, but only sometimes, which is why the city was
-- dropped in the first place (docs/geo.md). It describes where an address
-- block is REGISTERED: a transit operator's block is registered at its head
-- office, and an anycast CDN address answers from whichever of its dozens of
-- sites is nearest, so "the city" does not exist at all. A flow carries no
-- round-trip time, so unlike a hop there is nothing to check the claim
-- against. src/geo/destinationPlace.js therefore writes a city only when the
-- ASN is neither hosting nor anycast AND the city database agrees with the
-- country database about the country; everything else leaves these NULL and
-- stays on the centroid.
--
-- `city`      the city name, or NULL for "we would be guessing".
-- `city_lat`  }  the point to draw it on. Both NULL whenever city is NULL;
-- `city_lng`  }  never 0,0, which is a place in the Atlantic.
--
-- NULL on every row written before this migration and on every row whose
-- destination is a cloud, a CDN or a disagreement — so the map falls back to
-- the centroid per destination, not per period.
--
-- No index. The destination aggregate already groups by (country, asn) behind
-- idx_flows_country_ts and the city only widens that key; flow_records is the
-- highest-volume insert path in the product, so an index waits for a query
-- that needs one.

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'flow_records'
                      AND column_name = 'city'),
  'DO 0',
  'ALTER TABLE flow_records ADD COLUMN city VARCHAR(100) NULL DEFAULT NULL AFTER asn_name');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'flow_records'
                      AND column_name = 'city_lat'),
  'DO 0',
  'ALTER TABLE flow_records ADD COLUMN city_lat DECIMAL(8,5) NULL DEFAULT NULL AFTER city');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE() AND table_name = 'flow_records'
                      AND column_name = 'city_lng'),
  'DO 0',
  'ALTER TABLE flow_records ADD COLUMN city_lng DECIMAL(8,5) NULL DEFAULT NULL AFTER city_lat');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
