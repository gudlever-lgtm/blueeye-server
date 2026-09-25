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
// A COUNTRY CENTROID IS A REGION, NOT A POINT, and testing it as a point was a
// bug that called ordinary transit routers anycast. A hop registered in DE, seen
// from Denmark in 2.9 ms, was measured against the middle of Germany — 465 km,
// just over its 437 km budget — and dropped off the map as "usually an anycast
// address". But the centroid was never a claim about where the router is: only
// the COUNTRY came from GeoIP. Hamburg is 272 km from that agent and comfortably
// inside the same budget, so "somewhere in DE" is entirely feasible. A
// country-precision candidate is therefore tested against the nearest part of
// the country it stands for (its centroid less the country's own reach).
//
// FEASIBLE AS A COUNTRY IS NOT A PLACE. A hop that fits the country but not its
// centroid used to be drawn on the centroid anyway, marked approximate. That
// drew a DigitalOcean router answering in 4 ms from Copenhagen in the middle of
// the Czech Republic, 680 km away, because its block is registered there — a
// line across the map that no packet took. Such a hop now gets no coordinates
// here (`rejected[].regionOnly`, plus `withinKm`), and settlePath() below
// places it by what the path itself says: a reply only a millisecond or two
// behind a hop that IS placed came from the same place.
//
// When a candidate fails by a margin no country's size can explain — a public
// resolver registered in the US answering from 3 ms away, 7 491 km against a
// 724 km budget — it is `impossible`, and that is different in kind. The hop
// gets NO coordinates: drawing it in Kansas, even in a dashed circle, would put
// a mark 7 000 km from anywhere the responder can be. What IS known is reported
// instead, as `withinKm`: the responder is provably inside that radius of the
// agent, which is the only true thing there is to say about where it is.
//
// Private addresses are never looked up (docs/geo.md).

const KM_PER_MS_RTT = 100;
// Slack on the bound: the agent's site pin, a city's centre vs. its data
// centres, and traceroute's "<1 ms" reported as 0.5.
const RTT_SLACK_KM = 150;

// How far a country's centroid can sit from the nearest part of that country —
// i.e. how wrong the centroid is allowed to be before "somewhere in this
// country" stops being a feasible answer. Only the countries whose size makes a
// difference are listed; everything else gets the default, which comfortably
// covers a European country.
//
// The reach never places a hop. It only decides which note an unplaced hop
// gets: "registered in DE, somewhere within X km" (regionOnly) versus "no part
// of this country is that close" (anycast). A missing entry costs the default.
const DEFAULT_COUNTRY_REACH_KM = 600;
const COUNTRY_REACH_KM = Object.freeze({
  RU: 4000, US: 2500, CA: 3000, CN: 2500, BR: 2200, AU: 2000, IN: 1600,
  KZ: 1500, AR: 1900, DZ: 1200, GL: 1500, SA: 1100, MX: 1300, ID: 2600,
  NO: 900, SE: 800, FI: 600, CL: 2100, ZA: 800, TR: 800, UA: 700,
});

function countryReachKm(code) {
  if (!code) return DEFAULT_COUNTRY_REACH_KM;
  const r = COUNTRY_REACH_KM[String(code).toUpperCase()];
  return Number.isFinite(r) ? r : DEFAULT_COUNTRY_REACH_KM;
}

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
// `reachKm` widens the target from a point to a region — used for a country
// centroid, which stands for the whole country rather than a spot in it.
function feasible(origin, point, rttMs, reachKm = 0) {
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) return null;
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  if (!(typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs >= 0)) return null;
  const nearest = Math.max(0, haversineKm(origin, point) - (Number.isFinite(reachKm) ? reachKm : 0));
  return nearest <= maxDistanceKm(rttMs);
}

const EMPTY = Object.freeze({
  country: null, asn: null, asnName: null, lat: null, lng: null, private: false,
  hostname: null, place: null, rejected: null, withinKm: null,
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
    // A country centroid stands for the whole country, so it is tested against
    // the nearest part of it. A city is a point and is tested as one.
    const reachKm = c.precision === 'country' ? countryReachKm(c.country) : 0;
    const asPoint = feasible(origin, c, rttMs);
    if (asPoint === false) {
      // `regionOnly`: the country is feasible, the point is not. Not anycast —
      // just not somewhere a pin can honestly go. settlePath() may still place
      // it next to a neighbour; otherwise the map says what is known.
      const regionOnly = reachKm > 0 && feasible(origin, c, rttMs, reachKm) === true;
      rejected.push({
        source: c.source, city: c.city, country: c.country,
        distanceKm: Math.round(haversineKm(origin, c)), maxKm: Math.round(maxDistanceKm(rttMs)),
        reachKm: reachKm || undefined,
        regionOnly: regionOnly || undefined,
      });
      continue;
    }
    out.lat = c.lat;
    out.lng = c.lng;
    out.place = { city: c.city, country: c.country, precision: c.precision, source: c.source, certainty: 'exact' };
    if (c.code) out.place.code = c.code;
    break;
  }
  if (rejected.length) out.rejected = rejected;
  // Nothing could be placed, but the reply time still bounds where the
  // responder is. That bound is the only true statement left about its
  // location, so it is reported rather than thrown away.
  if (out.lat == null && rejected.length && Number.isFinite(rttMs)) {
    out.withinKm = Math.round(maxDistanceKm(rttMs));
  }
  return out;
}

// ---- placing hops by the path itself ----------------------------------------
//
// GeoIP answers each hop alone. The path answers them together: a hop whose
// reply came back only a millisecond or two after a hop that IS placed stands
// in the same place, give or take ~100-200 km — whatever its address block
// says. Cloud and transit networks are exactly where GeoIP is weakest (a block
// is registered where the company is, not where the rack is), and exactly where
// consecutive hops sit in one building.
//
// settlePath(items, { origin }) walks the hops in TTL order. `items` are
//   { hop, rttMs, node }   rttMs = the fastest reply seen; node = the hop's
//                          record (lat, lng, place, withinKm, private, ip)
// and it changes `node` in place:
//
//   * A hop with its own CITY placement (router name or city GeoIP, already
//     checked against the RTT) keeps it and becomes the new anchor.
//   * A hop that is unplaced, or placed only at a country centroid, is moved
//     to the last anchor when its reply is at most NEAR_MS behind it — or, for
//     the agent itself (anchor 0), at most LOCAL_MS in total. Its place says so:
//     { source: 'latency', nearHop, deltaMs }.
//   * A moved hop never becomes an anchor itself, so a chain of 1.9 ms steps
//     cannot creep a pin across a continent.
//
// LOCAL_MS is larger than NEAR_MS because the first public hop carries the
// access link (DSL, cable, 4G) on top of distance. 5 ms still bounds it to
// ~650 km, and it only ever moves a hop GeoIP could not place better.
const NEAR_MS = 2;
const LOCAL_MS = 5;

function settlePath(items, { origin = null } = {}) {
  const hasOrigin = origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng);
  let anchor = hasOrigin
    ? { hop: 0, rttMs: 0, lat: origin.lat, lng: origin.lng, city: null, country: null, precision: 'site' }
    : null;
  const sorted = (items || []).filter((x) => x && x.node).slice().sort((a, b) => a.hop - b.hop);
  for (const { hop, rttMs, node } of sorted) {
    if (!node.ip || node.private) continue;
    const r = typeof rttMs === 'number' && Number.isFinite(rttMs) ? rttMs : null;
    const p = node.place;
    const strong = node.lat != null && p && p.precision === 'city';
    if (strong) {
      anchor = { hop, rttMs: r, lat: node.lat, lng: node.lng, city: p.city, country: p.country, precision: 'city' };
      continue;
    }
    if (!anchor || r == null || anchor.rttMs == null) continue;
    const delta = r - anchor.rttMs;
    const limit = anchor.hop === 0 ? LOCAL_MS : NEAR_MS;
    if (delta > limit) continue;
    node.lat = anchor.lat;
    node.lng = anchor.lng;
    node.place = {
      city: anchor.city, country: anchor.country, precision: anchor.precision,
      source: 'latency', certainty: 'exact', nearHop: anchor.hop,
      deltaMs: Math.round(Math.max(0, delta) * 10) / 10,
    };
    node.withinKm = null;
  }
  return items;
}

module.exports = {
  settlePath, NEAR_MS, LOCAL_MS,
  locateHop, feasible, haversineKm, maxDistanceKm,
  countryReachKm, KM_PER_MS_RTT, RTT_SLACK_KM, DEFAULT_COUNTRY_REACH_KM, COUNTRY_REACH_KM,
};
