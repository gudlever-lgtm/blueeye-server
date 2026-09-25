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
// THE SPEED OF LIGHT IS A NOTE, NOT A FILTER. Light in fibre covers about
// 200 km per millisecond, so a reply that took R ms round trip came from at
// most R x 100 km away. That is worth SAYING about a placement, and it used to
// decide whether the hop was drawn at all — which threw away the only thing
// known about most hops. A path drawn with holes in it, or with every near hop
// stacked on the agent, tells an operator less than one that draws what the
// address says and marks how sure it is.
//
// So every hop that can be placed IS placed, and `place.certainty` says how
// well the reply time supports it:
//
//   'exact'        the position is inside what the reply time allows (or there
//                  is no agent position / no RTT, so nothing can be checked).
//   'approximate'  a country centroid the reply rules out as a point, while the
//                  country itself is feasible — the marker stands for the
//                  country, not a spot in it.
//   'registration' the reply came back far too fast for anywhere in that
//                  country: an anycast address, or a block registered a
//                  continent away from the rack. Drawn where it is registered,
//                  said plainly, with `withinKm` for what IS known.
//
// Private addresses are never looked up (docs/geo.md).
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
  hostname: null, place: null, rejected: null, withinKm: null, alternatives: null,
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

  // The best candidate available is the one drawn. The reply time only decides
  // how the marker is LABELLED — never whether it appears.
  const c = candidates[0];
  if (c) {
    const reachKm = c.precision === 'country' ? countryReachKm(c.country) : 0;
    const asPoint = feasible(origin, c, rttMs);
    const asRegion = reachKm > 0 ? feasible(origin, c, rttMs, reachKm) : asPoint;
    const certainty = asPoint !== false ? 'exact' : (asRegion !== false ? 'approximate' : 'registration');
    out.lat = c.lat;
    out.lng = c.lng;
    out.place = { city: c.city, country: c.country, precision: c.precision, source: c.source, certainty };
    if (c.code) out.place.code = c.code;
    if (certainty !== 'exact') {
      out.place.offByKm = Math.max(0, Math.round(haversineKm(origin, c) - maxDistanceKm(rttMs)));
      // What the reply time proves on its own, whatever the address says.
      out.withinKm = Math.round(maxDistanceKm(rttMs));
    }
    // The candidates NOT drawn, so the drawer can show what else was on offer
    // (the rDNS city behind a GeoIP country, say) without a second lookup.
    if (candidates.length > 1) {
      out.alternatives = candidates.slice(1).map((a) => ({ city: a.city, country: a.country, source: a.source }));
    }
  } else if (Number.isFinite(rttMs) && origin) {
    // Nothing to place it by, but the reply time still bounds it.
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
//
// It only fills in hops that GeoIP could place NOWHERE — no router name, no
// city, no country. Such a hop used to leave a hole in the path; when its reply
// came back within a millisecond or two of a hop that IS placed, it stands in
// the same place, and drawing it there beats drawing nothing.
//
// It never moves a hop that has a position of its own. Overriding the address's
// own answer with "near the previous hop" collapsed whole paths onto the agent
// and hid what the data actually said.
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
    // A hop with a position of its own keeps it, and becomes the anchor for the
    // unplaced hops behind it.
    if (node.lat != null && node.place) {
      anchor = { hop, rttMs: r, lat: node.lat, lng: node.lng, city: node.place.city, country: node.place.country, precision: node.place.precision };
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
