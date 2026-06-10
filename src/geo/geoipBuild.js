'use strict';

// Shared GeoIP-CSV builder: converts the EU-sourced DB-IP Lite files (db-ip.com,
// Belgium, CC-BY-4.0) into the provider's range format
//   start_ip,end_ip,country[,asn[,asn_name]]
// IPv4 only. Used by BOTH scripts/build-geoip.js (CLI) and the in-app updater
// (Settings → Map → "Update now"), so the two never drift. Node stdlib only — no
// dependency, in keeping with the on-prem / no-US-SDK constraint.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const readline = require('readline');

// Dotted IPv4 -> 32-bit int, or null for anything that isn't plain IPv4 (e.g.
// IPv6, which contains ':'). Mirrors the server's ipv4ToInt semantics.
function ipv4ToInt(s) {
  if (typeof s !== 'string' || s.indexOf(':') !== -1) return null;
  const parts = s.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

// Minimal CSV line splitter that honours double-quoted fields (DB-IP quotes the
// AS-organisation, which can contain commas).
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const intToIp = (n) => `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;

const csvCell = (s) => {
  const v = String(s == null ? '' : s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

// A readable stream for a local file or an https URL, gunzipped when the source
// looks gzipped (.gz). `httpGet` is injectable for tests. Returns Promise<Readable>.
function openSource({ file, url, httpGet = https.get }) {
  return new Promise((resolve, reject) => {
    const gunzipIf = (stream, name) => (/\.gz$/i.test(name) ? stream.pipe(zlib.createGunzip()) : stream);
    if (file) {
      if (!fs.existsSync(file)) return reject(new Error(`no such file: ${file}`));
      return resolve(gunzipIf(fs.createReadStream(file), file));
    }
    if (!url) return reject(new Error('openSource needs a file or url'));
    const get = (u, redirects) => httpGet(u, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return get(new URL(res.headers.location, u).href, redirects - 1);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${u}`)); }
      resolve(gunzipIf(res, u));
    });
    get(url, 5).on('error', reject);
  });
}

// Loads a DB-IP-style range file (local or URL) into a sorted array of
// { lo, hi, ...extra }, IPv4 rows only. `pick(cols)` maps a CSV row to extras.
async function loadRanges(source, pick) {
  const stream = await openSource(source);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const ranges = [];
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = splitCsv(line);
    const lo = ipv4ToInt(cols[0]);
    const hi = ipv4ToInt(cols[1]);
    if (lo === null || hi === null || hi < lo) continue; // IPv6 / header / junk
    ranges.push({ lo, hi, ...pick(cols) });
  }
  ranges.sort((a, b) => a.lo - b.lo);
  return ranges;
}

// Range-joins ASN ranges onto country ranges: walks both sorted lists once and,
// for every country interval, emits sub-segments carrying the overlapping ASN
// (and the gaps with country only). Output stays sorted and non-overlapping —
// exactly what the provider's binary search expects.
function* joinCountryAsn(country, asn) {
  let ai = 0;
  for (const c of country) {
    while (ai < asn.length && asn[ai].hi < c.lo) ai += 1;
    let cursor = c.lo;
    let j = ai;
    while (cursor <= c.hi) {
      while (j < asn.length && asn[j].hi < cursor) j += 1;
      const a = asn[j];
      if (!a || a.lo > c.hi) { yield { lo: cursor, hi: c.hi, country: c.country }; break; }
      if (a.lo > cursor) {
        yield { lo: cursor, hi: Math.min(a.lo - 1, c.hi), country: c.country };
        cursor = a.lo;
        continue;
      }
      const end = Math.min(a.hi, c.hi);
      yield { lo: cursor, hi: end, country: c.country, asn: a.asn, asnName: a.asnName };
      cursor = end + 1;
    }
  }
}

// Writes the (optionally ASN-joined) ranges to `outPath` atomically (temp file +
// rename). Returns the number of rows written. `source` is a label for the header.
// The temp file lives in the SAME directory as `outPath` (not os.tmpdir()) so the
// rename stays within one filesystem — across devices (e.g. /tmp → the Docker
// /data volume) rename() fails with EXDEV and the build would silently never land.
async function writeCsv(outPath, country, asn, source = 'DB-IP Lite (CC-BY-4.0)') {
  const dir = path.dirname(path.resolve(outPath));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.geoip-${process.pid}-${Date.now()}.tmp`);
  const ws = fs.createWriteStream(tmp);
  const write = (s) => new Promise((res, rej) => { ws.write(s, (e) => (e ? rej(e) : res())); });
  try {
    await write(`# BlueEye GeoIP range table — built ${new Date().toISOString()} from ${source}\n`);
    await write('# format: start_ip,end_ip,country[,asn[,asn_name]]\n');
    let rows = 0;
    const emit = asn && asn.length ? joinCountryAsn(country, asn) : (function* () { yield* country; })();
    for (const r of emit) {
      if (!r.country) continue;
      const cells = [intToIp(r.lo), intToIp(r.hi), r.country];
      if (r.asn) cells.push(String(r.asn), csvCell(r.asnName || ''));
      await write(`${cells.join(',')}\n`); // eslint-disable-line no-await-in-loop
      rows += 1;
    }
    await new Promise((res, rej) => ws.end((err) => (err ? rej(err) : res())));
    fs.renameSync(tmp, outPath);
    return rows;
  } catch (e) {
    ws.destroy();
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

// High-level: load country (+ optional ASN) from file/URL sources and write the
// merged CSV to `out`. Returns { rows, countryRanges, asnRanges }.
async function buildFromSources({ country, asn = null, out, httpGet, source }) {
  const c = await loadRanges({ ...country, httpGet }, (cols) => ({ country: (cols[2] || '').trim().toUpperCase() || null }));
  let a = [];
  if (asn) a = await loadRanges({ ...asn, httpGet }, (cols) => ({ asn: Number(cols[2]) || null, asnName: (cols[3] || '').trim() || null }));
  const rows = await writeCsv(out, c, a, source);
  return { rows, countryRanges: c.length, asnRanges: a.length };
}

const DEFAULT_DBIP_BASE = 'https://download.db-ip.com/free';
const pad2 = (n) => String(n).padStart(2, '0');
const ym = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;

// DB-IP Lite download URLs for a given YYYY-MM.
function dbipUrls(baseUrl, month) {
  const b = String(baseUrl || DEFAULT_DBIP_BASE).replace(/\/+$/, '');
  return {
    country: `${b}/dbip-country-lite-${month}.csv.gz`,
    asn: `${b}/dbip-asn-lite-${month}.csv.gz`,
  };
}

// Months to try, newest first: the current month, then the previous one (early in
// a month the new file may not be published yet).
function monthCandidates(now = new Date()) {
  const cur = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [ym(cur), ym(prev)];
}

module.exports = {
  ipv4ToInt, splitCsv, intToIp, csvCell, openSource, loadRanges, joinCountryAsn,
  writeCsv, buildFromSources, dbipUrls, monthCandidates, DEFAULT_DBIP_BASE,
};
