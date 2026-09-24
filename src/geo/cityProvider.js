'use strict';

const fs = require('fs');
const readline = require('readline');
const { ipv4ToInt } = require('./privateIp');
const { splitCsv } = require('./geoipBuild');

const silentLogger = { info() {}, warn() {}, error() {} };

// City-level GeoIP: IP -> { city, country, lat, lng }. The FALLBACK for placing
// a traceroute hop on the map when the router's own name says nothing
// (src/geo/hopLocation.js tries the name first). Flows never use it — they stay
// at country level (docs/geo.md).
//
// Why it is only a fallback: city GeoIP describes where an address block is
// REGISTERED or where its users are, and a router's address block is usually
// registered at the operator's head office. A TDC router in Aarhus can come out
// as Copenhagen. Every placement is still checked against the hop's round-trip
// time before it is drawn.
//
// Source: DB-IP "IP to City Lite" (db-ip.com, Belgium/EU, CC-BY-4.0), built by
// src/geo/geoipBuild.js into
//   start_ip,end_ip,country,lat,lng,city
// IPv4 only, like the country table.
//
// MEMORY. The file has millions of ranges, so they are held in typed arrays
// (20 bytes a range) rather than one object each, and the city names are
// interned. The file is read as a stream, so loading never holds the whole text
// in memory either. Loading is asynchronous; lookups answer null until it is
// done, and status() says `loading`.

const INITIAL = 1 << 16;

function createTable() {
  let cap = INITIAL;
  let n = 0;
  let lo = new Uint32Array(cap);
  let hi = new Uint32Array(cap);
  let lat = new Float32Array(cap);
  let lng = new Float32Array(cap);
  let place = new Uint32Array(cap);
  const places = [];
  const placeIdx = new Map();

  function grow() {
    cap *= 2;
    const g = (A, old) => { const a = new A(cap); a.set(old); return a; };
    lo = g(Uint32Array, lo); hi = g(Uint32Array, hi);
    lat = g(Float32Array, lat); lng = g(Float32Array, lng);
    place = g(Uint32Array, place);
  }

  function add(r) {
    if (n === cap) grow();
    const key = `${r.country}|${r.city}`;
    let pi = placeIdx.get(key);
    if (pi === undefined) { pi = places.length; places.push({ country: r.country, city: r.city }); placeIdx.set(key, pi); }
    lo[n] = r.lo; hi[n] = r.hi; lat[n] = r.lat; lng[n] = r.lng; place[n] = pi;
    n += 1;
  }

  // Sorted by lower bound for the binary search. The built file is already in
  // order; anything else is sorted through an index permutation.
  function finish() {
    let sorted = true;
    for (let i = 1; i < n; i += 1) if (lo[i] < lo[i - 1]) { sorted = false; break; }
    if (!sorted) {
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => lo[a] - lo[b]);
      const pick = (A, src) => { const a = new A(n); for (let i = 0; i < n; i += 1) a[i] = src[order[i]]; return a; };
      lo = pick(Uint32Array, lo); hi = pick(Uint32Array, hi);
      lat = pick(Float32Array, lat); lng = pick(Float32Array, lng);
      place = pick(Uint32Array, place);
    }
    return { size: n, find };
  }

  function find(x) {
    let a = 0;
    let b = n - 1;
    let found = -1;
    while (a <= b) {
      const mid = (a + b) >> 1;
      if (lo[mid] <= x) { found = mid; a = mid + 1; } else { b = mid - 1; }
    }
    if (found === -1 || x > hi[found]) return null;
    const p = places[place[found]];
    return { city: p.city, country: p.country, lat: round4(lat[found]), lng: round4(lng[found]) };
  }

  return { add, finish };
}

const round4 = (v) => Math.round(v * 10000) / 10000;

// One row of the built file, or null for a header/comment/IPv6/junk line.
function parseRow(line) {
  if (!line || line[0] === '#') return null;
  const cols = splitCsv(line);
  const lo = /^\d+$/.test(cols[0]) ? Number(cols[0]) : ipv4ToInt(cols[0]);
  const hi = /^\d+$/.test(cols[1]) ? Number(cols[1]) : ipv4ToInt(cols[1]);
  if (lo == null || hi == null || Number.isNaN(lo) || Number.isNaN(hi) || hi < lo) return null;
  const country = String(cols[2] || '').trim().toUpperCase();
  const lat = Number(cols[3]);
  const lng = Number(cols[4]);
  if (!/^[A-Z]{2}$/.test(country) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const city = String(cols[5] || '').trim().slice(0, 120) || null;
  return { lo, hi, country, lat, lng, city };
}

function createCityProvider({ ranges, csv, dbPath, logger = silentLogger, createReadStream = fs.createReadStream } = {}) {
  let index = null;
  let size = 0;
  let source = null;
  let path = null;
  let error = null;
  let loading = false;
  let generation = 0;

  function fromRows(rows) {
    const t = createTable();
    for (const r of rows) if (r) t.add(r);
    return t.finish();
  }

  function install(ix, src, p) {
    index = ix.size ? ix : null;
    size = ix.size;
    source = ix.size ? src : null;
    path = p;
  }

  // Swaps in a new table. `ranges` (tests) and `csv` load synchronously; a
  // `dbPath` streams in the background and the returned promise resolves to the
  // range count. A newer reload() wins over one still streaming.
  function reload(opts = {}) {
    const gen = ++generation;
    error = null;
    if (Array.isArray(opts.ranges) && opts.ranges.length) {
      loading = false;
      install(fromRows(opts.ranges), 'ranges', null);
      return Promise.resolve(size);
    }
    if (typeof opts.csv === 'string' && opts.csv.trim()) {
      loading = false;
      install(fromRows(opts.csv.split(/\r?\n/).map((l) => parseRow(l.trim()))), 'csv', null);
      return Promise.resolve(size);
    }
    if (!opts.dbPath) {
      loading = false;
      install({ size: 0 }, null, null);
      return Promise.resolve(0);
    }
    const p = String(opts.dbPath);
    path = p;
    loading = true;
    return (async () => {
      const t = createTable();
      try {
        const stream = createReadStream(p, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const raw of rl) {
          if (gen !== generation) { rl.close(); stream.destroy(); return size; }
          const r = parseRow(raw.trim());
          if (r) t.add(r);
        }
        if (gen !== generation) return size;
        install(t.finish(), 'file', p);
        loading = false;
        logger.info(`geo: loaded ${size} city ranges from ${p}`);
      } catch (err) {
        if (gen !== generation) return size;
        error = err.message;
        loading = false;
        install({ size: 0 }, null, p);
        logger.warn(`geo: could not read city GeoIP database at ${p} (${err.message}) — hops fall back to country level`);
      }
      return size;
    })();
  }

  function lookup(ip) {
    if (!index) return null;
    const x = ipv4ToInt(ip);
    return x == null ? null : index.find(x);
  }

  function status() {
    return { configured: size > 0, size, source, path, error, loading };
  }

  const ready = reload({ ranges, csv, dbPath });

  return { lookup, reload, status, ready, get size() { return size; } };
}

module.exports = { createCityProvider, parseRow };
