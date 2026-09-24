'use strict';

const { isPrivate } = require('./privateIp');
const { placeFromHostname, cleanHostname } = require('./hostnameHints');

// Where to draw one traceroute hop on the map, and how sure we are.
//
// Three sources, best first:
//   1. rdns          the router's own name says its city (hostnameHints.js).
//                    Operators name routers after where they stand, so this is
//                    the most precise source there is for a transit hop.
//   2. geoip-city    city-level GeoIP (cityProvider.js), when the name says
//                    nothing. Often the operator's head office, not the router.
//   3. geoip-country the country centroid — what every hop used before.
//
// THE SPEED OF LIGHT CHECK. Light in fibre covers about 200 km per millisecond,
// so a reply that took R ms round trip came from at most R x 100 km away. A
// candidate further from the agent than that is physically impossible and is
// skipped for the next source. The bound only ever rejects: a slow reply (a
// router that answers ICMP from its slow path) says nothing about distance,
// so a long RTT never pulls a hop anywhere. It needs the agent's site
// coordinates; without them nothing can be checked and nothing is rejected.
//
// When every candidate is impossible — typically an anycast address such as a
// public DNS resolver, registered in the US and answering from 3 ms away — the
// hop gets NO coordinates and `rejected` says why. Drawing it in Kansas would
// be a confident lie.
//
// Private addresses are never looked up (docs/geo.md).

const KM_PER_MS_RTT = 100;
// Slack on the bound: the agent's site pin, a city's centre vs. its data
// centres, and traceroute's "<1 ms" reported as 0.5.
const RTT_SLACK_KM = 150;

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Farthest a reply of `rttMs` round trip can have come from, in km.
function maxDistanceKm(rttMs) {
  return rttMs * KM_PER_MS_RTT + RTT_SLACK_KM;
}

// null = could not be checked (no origin or no RTT); true/false otherwise.
function feasible(origin, point, rttMs) {
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) return null;
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  if (!(typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs >= 0)) return null;
  return haversineKm(origin, point) <= maxDistanceKm(rttMs);
}

const EMPTY = Object.freeze({
  country: null, asn: null, asnName: null, lat: null, lng: null, private: false,
  hostname: null, place: null, rejected: null,
});

//   locateHop({ ip, hostname, rttMs }, { geoProvider, cityProvider, centroids, origin })
//     rttMs    the lowest RTT seen for the hop (the tightest bound)
//     origin   { lat, lng } of the agent's site
//   -> { country, asn, asnName,            GeoIP registration (unchanged meaning)
//        lat, lng,                          where to draw it, or null
//        place: { city, country, precision: 'city'|'country', source, code? } | null,
//        rejected: [{ source, city, country, distanceKm, maxKm }] | null,
//        hostname, private }
function locateHop({ ip = null, hostname = null, rttMs = null } = {}, {
  geoProvider = null, cityProvider = null, centroids = null, origin = null,
} = {}) {
  const name = cleanHostname(hostname);
  if (!ip) return { ...EMPTY, hostname: name };
  if (isPrivate(ip)) return { ...EMPTY, private: true };

  const geo = geoProvider && typeof geoProvider.lookup === 'function' ? geoProvider.lookup(ip) : null;
  const out = {
    ...EMPTY,
    country: geo && geo.country ? geo.country : null,
    asn: geo ? geo.asn ?? null : null,
    asnName: geo ? geo.asnName ?? null : null,
    hostname: name,
  };

  const candidates = [];
  const fromName = name ? placeFromHostname(name) : null;
  if (fromName) candidates.push({ ...fromName, precision: 'city', source: 'rdns' });
  const fromCity = cityProvider && typeof cityProvider.lookup === 'function' ? cityProvider.lookup(ip) : null;
  if (fromCity && Number.isFinite(fromCity.lat) && Number.isFinite(fromCity.lng)) {
    candidates.push({ city: fromCity.city || null, country: fromCity.country, lat: fromCity.lat, lng: fromCity.lng, precision: 'city', source: 'geoip-city' });
  }
  const centroid = out.country && centroids ? centroids.get(out.country) : null;
  if (centroid) candidates.push({ city: null, country: out.country, lat: centroid.lat, lng: centroid.lng, precision: 'country', source: 'geoip-country' });

  const rejected = [];
  for (const c of candidates) {
    if (feasible(origin, c, rttMs) === false) {
      rejected.push({
        source: c.source, city: c.city, country: c.country,
        distanceKm: Math.round(haversineKm(origin, c)), maxKm: Math.round(maxDistanceKm(rttMs)),
      });
      continue;
    }
    out.lat = c.lat;
    out.lng = c.lng;
    out.place = { city: c.city, country: c.country, precision: c.precision, source: c.source };
    if (c.code) out.place.code = c.code;
    break;
  }
  if (rejected.length) out.rejected = rejected;
  return out;
}

module.exports = { locateHop, feasible, haversineKm, maxDistanceKm, KM_PER_MS_RTT, RTT_SLACK_KM };
