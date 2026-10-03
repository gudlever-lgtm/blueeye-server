'use strict';

const { ipv4ToInt, isPrivate } = require('./privateIp');

// The server's OWN hop locations, held in memory for lookup.
//
// `hop_locations` (migration 144) is what somebody wrote down about where a
// router actually stands — a manual correction, or a `geoloc:` published in the
// RIPE NCC database for the block. It is consulted FIRST for every traceroute
// hop (src/geo/hopLocation.js), ahead of the router name, city GeoIP and the
// country centroid, because it is the only source that is a statement rather
// than an inference.
//
// IN MEMORY because placement is synchronous and runs per hop per path; the
// table is small (tens to low thousands of rows) and only changes when somebody
// writes one. `reload()` after a write is what makes a correction take effect —
// the route calls it, so the next path drawn is already right.
//
// LONGEST PREFIX WINS, the way routing does: a /32 for one router inside a
// corrected /24 is the exception an operator expects to be able to make. Rows
// arrive sorted by prefix length descending (the repository's ORDER BY), and
// the scan keeps that order.
//
// IPv4 only, like every other range source here. A v6 row is kept as an exact
// string match so a single corrected v6 router still works, without pretending
// to do v6 prefix maths.

function maskLo(ip, prefixLen) {
  const n = ipv4ToInt(ip);
  if (n === null) return null;
  const len = Math.max(0, Math.min(32, Number(prefixLen) || 0));
  if (len === 0) return 0;
  const mask = len === 32 ? 0xffffffff : (0xffffffff << (32 - len)) >>> 0;
  return (n & mask) >>> 0;
}

function hiOf(lo, prefixLen) {
  const len = Math.max(0, Math.min(32, Number(prefixLen) || 0));
  const size = len === 32 ? 1 : 2 ** (32 - len);
  return (lo + size - 1) >>> 0;
}

// createHopCorrections({ repo, logger }) -> { lookup, reload, size, status }
//
// `repo` is the hop_locations repository (optional — without one the store is
// simply empty, which is what the tests and a server without the table get).
function createHopCorrections({ repo = null, logger = console } = {}) {
  let ranges = [];      // IPv4, longest prefix first
  let exact = new Map(); // non-IPv4 literals, by lower-cased address
  let loadedAt = null;

  function index(rows) {
    const v4 = [];
    const v6 = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !r.ip || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue;
      const entry = {
        ip: r.ip,
        prefixLen: r.prefixLen == null ? 32 : Number(r.prefixLen),
        lat: r.lat,
        lng: r.lng,
        city: r.city || null,
        country: r.country || null,
        source: r.source === 'ripe' ? 'ripe' : 'manual',
        note: r.note || null,
      };
      const lo = maskLo(entry.ip, entry.prefixLen);
      if (lo === null) { v6.set(String(entry.ip).trim().toLowerCase(), entry); continue; }
      v4.push({ ...entry, lo, hi: hiOf(lo, entry.prefixLen) });
    }
    v4.sort((a, b) => b.prefixLen - a.prefixLen);
    ranges = v4;
    exact = v6;
  }

  // The correction covering `ip`, or null. Private addresses are never looked
  // up — they are never geolocated anywhere in this layer.
  function lookup(ip) {
    if (!ip || isPrivate(ip)) return null;
    const n = ipv4ToInt(ip);
    if (n === null) return exact.get(String(ip).trim().toLowerCase()) || null;
    for (const r of ranges) if (n >= r.lo && n <= r.hi) return r;
    return null;
  }

  async function reload() {
    if (!repo || typeof repo.all !== 'function') { index([]); return 0; }
    try {
      index(await repo.all());
      loadedAt = new Date();
      return ranges.length + exact.size;
    } catch (err) {
      // A failed reload keeps the previous index: a database hiccup must not
      // silently take every correction off the map.
      if (logger && logger.warn) logger.warn({ err }, 'hop corrections reload failed');
      return ranges.length + exact.size;
    }
  }

  const size = () => ranges.length + exact.size;

  return {
    lookup,
    reload,
    size,
    status: () => ({ size: size(), loadedAt }),
    // Tests and the importer wire rows straight in, without a database.
    load: (rows) => { index(rows); loadedAt = new Date(); return size(); },
  };
}

module.exports = { createHopCorrections, maskLo, hiOf };
