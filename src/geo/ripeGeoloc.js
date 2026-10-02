'use strict';

const { ipv4ToInt, isPrivate } = require('./privateIp');

// RIPE NCC database -> hop locations.
//
// WHERE THIS FITS. Everything else in this layer infers a position: a router's
// name, a city range file, a country centroid. The RIPE database carries
// something different — `geoloc:`, the coordinates the HOLDER of the address
// block published for it. It is the operator saying where their own equipment
// is, in a European registry, in a file that can be downloaded and read
// offline. That is the same class of statement as an operator correcting a hop
// in the UI, which is why both land in the same table (`hop_locations`,
// migration 144) and are read by the same lookup.
//
// NOT EVERY BLOCK HAS ONE — `geoloc:` is optional and most holders leave it
// out, so this is a seed for the table, not a replacement for GeoIP. The rows
// it does produce are worth more than any range file, because nobody else is
// in a position to know.
//
// OFFLINE AND EUROPEAN, like every other source here: a split file from the
// RIPE NCC FTP (`ripe.db.inetnum.gz`), parsed locally. No runtime API call, no
// US vendor. The importer never overwrites a manual correction — a person who
// wrote down where a router stands outranks what the registry says about the
// block it sits in.
//
// RPSL, the format: records separated by blank lines, `attribute: value`, with
// continuation lines indented. Only three attributes matter here:
//
//   inetnum:  193.162.153.0 - 193.162.153.255
//   country:  DK
//   geoloc:   55.676100 12.568300

// A `geoloc:` value is "<latitude> <longitude>" in decimal degrees.
function parseGeoloc(value) {
  const m = String(value || '').trim().match(/^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  // 0,0 is in the Atlantic and is what a half-filled template leaves behind.
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

// An inetnum range ("a - b") as the CIDR blocks that exactly cover it. RIPE
// ranges are arbitrary, the table is keyed by prefix, and a range that is not a
// single prefix (a /23 handed out as 1.5 /24s) must not be rounded outwards —
// that would move addresses the holder never claimed.
function rangeToCidrs(text, { maxBlocks = 64, minPrefixLen = 8 } = {}) {
  const m = String(text || '').trim().match(/^([\d.]+)\s*-\s*([\d.]+)$/);
  if (!m) return [];
  let lo = ipv4ToInt(m[1]);
  const hi = ipv4ToInt(m[2]);
  if (lo === null || hi === null || hi < lo) return [];
  const out = [];
  while (lo <= hi && out.length < maxBlocks) {
    // The largest block that starts at `lo` and does not run past `hi`.
    let size = lo === 0 ? 2 ** 32 : (lo & -lo) >>> 0;
    while (size - 1 > hi - lo) size /= 2;
    const len = 32 - Math.log2(size);
    if (len >= minPrefixLen) {
      out.push({
        ip: [lo >>> 24, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255].join('.'),
        prefixLen: len,
      });
    }
    if (lo + size > 0xffffffff) break;
    lo += size;
  }
  return out;
}

// parseRipeInetnums(text, opts) -> [{ ip, prefixLen, lat, lng, country, source }]
//
// `text` is a chunk of RPSL — the whole file, or one read of a stream split on
// record boundaries. Records without a usable `geoloc:` are skipped, which is
// most of them.
function parseRipeInetnums(text, { maxBlocks = 64, minPrefixLen = 8 } = {}) {
  const rows = [];
  for (const record of String(text || '').split(/\n\s*\n/)) {
    if (record.indexOf('geoloc:') === -1) continue;
    let inetnum = null;
    let country = null;
    let geoloc = null;
    for (const line of record.split('\n')) {
      if (line.startsWith('%') || line.startsWith('#')) continue;
      const i = line.indexOf(':');
      if (i === -1) continue;
      const key = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim();
      if (key === 'inetnum' && !inetnum) inetnum = value;
      else if (key === 'country' && !country) country = value.slice(0, 2).toUpperCase();
      else if (key === 'geoloc' && !geoloc) geoloc = parseGeoloc(value);
    }
    if (!inetnum || !geoloc) continue;
    for (const block of rangeToCidrs(inetnum, { maxBlocks, minPrefixLen })) {
      // A registry record for a private block exists (RFC1918 space is
      // documented in registries too) and must never reach the geo layer.
      if (isPrivate(block.ip)) continue;
      rows.push({
        ...block,
        lat: geoloc.lat,
        lng: geoloc.lng,
        city: null,
        country: /^[A-Z]{2}$/.test(country || '') ? country : null,
        source: 'ripe',
        note: 'RIPE geoloc',
      });
    }
  }
  return rows;
}

module.exports = { parseRipeInetnums, parseGeoloc, rangeToCidrs };
