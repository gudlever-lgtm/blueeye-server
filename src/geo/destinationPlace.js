'use strict';

const { providerOf } = require('./hostingNetworks');

// Where to draw an external destination.
//
// The honest default is the country centroid (docs/geo.md): city GeoIP says
// where an address block is REGISTERED, which for a transit operator is its
// head office and for a CDN is wherever the company happens to be. A flow
// carries no round-trip time, so unlike a traceroute hop there is nothing to
// check a city claim against — the only defence is to refuse to make one.
//
// So a destination is placed on its city ONLY when the claim is cheap to
// believe:
//
//   * the ASN is not a cloud/hosting network (hostingNetworks.js) and not one
//     of the anycast CDNs below — their addresses answer from whichever of
//     dozens of sites is nearest, so "the city" does not exist;
//   * the city database agrees with the country database about the country —
//     two sources saying the same thing is the only corroboration available;
//   * there is a city name and a usable point.
//
// Everything else keeps `city: null` and is drawn on the country centroid.
// `precision` travels with the destination so the map can show which is which.

// Anycast / CDN networks on top of the hosting list: one address, many sites.
const ANYCAST = [
  { name: 'Cloudflare', asns: [13335, 209242, 132892], re: /cloudflare/i },
  { name: 'Akamai', asns: [20940, 16625, 32787, 21342, 35994], re: /akamai/i },
  { name: 'Fastly', asns: [54113], re: /fastly/i },
  { name: 'Edgio', asns: [22822, 38622], re: /edgio|limelight/i },
  { name: 'Gcore', asns: [199524], re: /g-?core/i },
  { name: 'Bunny', asns: [200325], re: /bunny/i },
  { name: 'StackPath', asns: [12989, 33438], re: /stackpath|highwinds/i },
  { name: 'Meta', asns: [32934], re: /facebook|\bmeta\b/i },
  { name: 'Netflix', asns: [2906, 40027], re: /netflix/i },
  { name: 'Apple', asns: [714, 6185], re: /\bapple\b/i },
  { name: 'Twitter / X', asns: [13414, 35995], re: /twitter|\bx\.com\b/i },
];

// The name of the anycast/hosting network an address belongs to, or null.
// Exported so a caller can say WHY a destination stayed at country level.
function sharedNetworkOf(asn, asnName) {
  const n = Number(asn);
  for (const p of ANYCAST) {
    if (Number.isInteger(n) && p.asns.includes(n)) return p.name;
  }
  if (typeof asnName === 'string' && asnName) {
    for (const p of ANYCAST) if (p.re.test(asnName)) return p.name;
  }
  return providerOf(asn, asnName);
}

const usable = (v) => typeof v === 'number' && Number.isFinite(v);

//   const placer = createDestinationPlacer({ cityProvider });
//   placer.place('203.0.113.9', { country: 'DK', asn: 3292, asnName: 'TDC' })
//     -> { city: 'Aarhus', lat: 56.15, lng: 10.21 } | null
function createDestinationPlacer({ cityProvider = null } = {}) {
  const canLookUp = () => !!(cityProvider && typeof cityProvider.lookup === 'function');

  function place(ip, { country = null, asn = null, asnName = null } = {}) {
    if (!ip || !country || !canLookUp()) return null;
    if (sharedNetworkOf(asn, asnName)) return null;
    let hit = null;
    try { hit = cityProvider.lookup(ip); } catch { return null; }
    if (!hit || !hit.city) return null;
    // The two databases must agree on the country before we believe the city.
    if (!hit.country || String(hit.country).toUpperCase() !== String(country).toUpperCase()) return null;
    if (!usable(hit.lat) || !usable(hit.lng)) return null;
    return { city: String(hit.city).slice(0, 100), lat: hit.lat, lng: hit.lng };
  }

  return { place };
}

module.exports = { createDestinationPlacer, sharedNetworkOf, ANYCAST };
