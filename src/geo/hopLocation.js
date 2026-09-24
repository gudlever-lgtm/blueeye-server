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
// the country it stands for (its centroid less the country's own reach), and a
// hop that only fails as a point is kept with `certainty: 'approximate'` —
// drawn, and drawn as a guess.
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
// These numbers only ever ADD tolerance to a check that rejects, so an
// over-generous entry costs a hop drawn as approximate rather than dropped —
// and an approximate hop says so on the map. A missing entry costs the default.
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

  // Two passes. The first takes a candidate the check accepts outright; only if
  // none does is an `approximate` one taken. A near-miss must never be drawn
  // ahead of a candidate that is simply feasible.
  const rejected = [];
  let fallback = null;
  for (const c of candidates) {
    // A country centroid stands for the whole country, so it is tested against
    // the nearest part of it. A city is a point and is tested as one.
    const reachKm = c.precision === 'country' ? countryReachKm(c.country) : 0;
    const asPoint = feasible(origin, c, rttMs);
    const asRegion = feasible(origin, c, rttMs, reachKm);

    if (asRegion === false) {
      // No extent of this country reaches the agent inside the time the reply
      // took. The registration is not where the responder is — anycast — and
      // there is nowhere honest to draw it.
      rejected.push({
        source: c.source, city: c.city, country: c.country,
        distanceKm: Math.round(haversineKm(origin, c)), maxKm: Math.round(maxDistanceKm(rttMs)),
        reachKm: reachKm || undefined,
      });
      continue;
    }

    const certainty = asPoint === false ? 'approximate' : 'exact';
    const placed = {
      lat: c.lat,
      lng: c.lng,
      place: { city: c.city, country: c.country, precision: c.precision, source: c.source, certainty },
    };
    if (c.code) placed.place.code = c.code;

    if (certainty === 'exact') {
      Object.assign(out, placed);
      fallback = null;
      break;
    }
    // Feasible only as a region: remember it, but keep looking for better. The
    // distance that failed is recorded either way, so the map can say how far
    // off the pin may be.
    if (!fallback) {
      fallback = placed;
      fallback.place.offByKm = Math.max(0, Math.round(haversineKm(origin, c) - maxDistanceKm(rttMs)));
    }
  }
  if (!out.lat && fallback) Object.assign(out, fallback);
  if (rejected.length) out.rejected = rejected;
  // Nothing could be placed, but the reply time still bounds where the
  // responder is. That bound is the only true statement left about its
  // location, so it is reported rather than thrown away.
  if (out.lat == null && rejected.length && Number.isFinite(rttMs)) {
    out.withinKm = Math.round(maxDistanceKm(rttMs));
  }
  return out;
}

module.exports = {
  locateHop, feasible, haversineKm, maxDistanceKm,
  countryReachKm, KM_PER_MS_RTT, RTT_SLACK_KM, DEFAULT_COUNTRY_REACH_KM, COUNTRY_REACH_KM,
};
