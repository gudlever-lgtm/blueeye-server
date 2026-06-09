#!/usr/bin/env node
'use strict';

// Builds the offline GeoIP/ASN range CSV that the server's geo provider reads
// (GEOIP_DB_PATH, or Settings → Map → GeoIP database). It converts the EU-sourced
// DB-IP Lite files (db-ip.com, Belgium, CC-BY-4.0) into the provider's format:
//
//   start_ip,end_ip,country[,asn[,asn_name]]
//
// IPv4 only (the default reader ignores IPv6). The country file gives the
// geolocation; the optional ASN file is range-joined onto it for ASN/org labels.
//
// Usage:
//   node scripts/build-geoip.js --country dbip-country-lite.csv[.gz] \
//        [--asn dbip-asn-lite.csv[.gz]] [--out geoip.csv]
//   node scripts/build-geoip.js --country-url <URL> [--asn-url <URL>] [--out geoip.csv]
//
// Inputs may be plain CSV or gzip (.gz, auto-detected). With *-url, the file is
// streamed over HTTPS (follows redirects). No third-party dependency — Node stdlib
// only (https/zlib/readline/fs), in keeping with the no-US-SDK, on-prem constraint.
//
// Get the Lite files (free, monthly) from https://db-ip.com/db/lite.php —
// "IP to Country Lite" and "IP to ASN Lite", CSV.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const readline = require('readline');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

function die(msg) { process.stderr.write(`ERROR: ${msg}\n`); process.exit(1); }
function log(msg) { process.stderr.write(`${msg}\n`); }

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
// AS-organisation, which can contain commas). Good enough for these files.
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

// A readable stream for a local file or an https URL, gunzipped when the source
// looks gzipped (.gz suffix). Returns a Promise<stream.Readable>.
function openSource({ file, url }) {
  return new Promise((resolve, reject) => {
    const gunzipIf = (stream, name) => (/\.gz$/i.test(name) ? stream.pipe(zlib.createGunzip()) : stream);
    if (file) {
      if (!fs.existsSync(file)) return reject(new Error(`no such file: ${file}`));
      return resolve(gunzipIf(fs.createReadStream(file), file));
    }
    const get = (u, redirects) => https.get(u, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return get(new URL(res.headers.location, u).href, redirects - 1);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${u}`)); }
      resolve(gunzipIf(res, u));
    }).on('error', reject);
    get(url, 5);
  });
}

// Loads a DB-IP-style range file into a sorted array of { lo, hi, ...extra },
// keeping IPv4 rows only. `pick(cols)` maps a CSV row to the extra fields.
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

const intToIp = (n) => `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;

const csvCell = (s) => {
  const v = String(s == null ? '' : s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.country && !args['country-url'])) {
    log('Build the server GeoIP CSV from DB-IP Lite files (IPv4, EU-sourced).\n');
    log('  node scripts/build-geoip.js --country <file.csv[.gz]> [--asn <file.csv[.gz]>] [--out geoip.csv]');
    log('  node scripts/build-geoip.js --country-url <URL> [--asn-url <URL>] [--out geoip.csv]\n');
    log('Get the Lite CSVs from https://db-ip.com/db/lite.php (CC-BY-4.0).');
    process.exit(args.help ? 0 : 1);
  }
  const outPath = args.out || 'geoip.csv';

  log('Loading country ranges…');
  const country = await loadRanges(
    { file: args.country, url: args['country-url'] },
    (cols) => ({ country: (cols[2] || '').trim().toUpperCase() || null })
  ).catch((e) => die(`country file: ${e.message}`));
  log(`  ${country.length} IPv4 country ranges`);

  let asn = [];
  if (args.asn || args['asn-url']) {
    log('Loading ASN ranges…');
    asn = await loadRanges(
      { file: args.asn, url: args['asn-url'] },
      (cols) => ({ asn: Number(cols[2]) || null, asnName: (cols[3] || '').trim() || null })
    ).catch((e) => die(`asn file: ${e.message}`));
    log(`  ${asn.length} IPv4 ASN ranges`);
  }

  // Atomic write: build to a temp file, then rename over the target.
  const tmp = path.join(os.tmpdir(), `geoip-${process.pid}-${Date.now()}.csv`);
  const ws = fs.createWriteStream(tmp);
  const write = (s) => new Promise((res) => { ws.write(s) ? res() : ws.once('drain', res); });

  await write(`# BlueEye GeoIP range table — built ${new Date().toISOString()} from DB-IP Lite (CC-BY-4.0)\n`);
  await write('# format: start_ip,end_ip,country[,asn[,asn_name]]\n');

  let rows = 0;
  const emit = asn.length ? joinCountryAsn(country, asn) : (function* () { yield* country; })();
  for (const r of emit) {
    if (!r.country) continue;
    const cells = [intToIp(r.lo), intToIp(r.hi), r.country];
    if (r.asn) { cells.push(String(r.asn), csvCell(r.asnName || '')); }
    await write(`${cells.join(',')}\n`); // eslint-disable-line no-await-in-loop
    rows += 1;
  }
  await new Promise((res, rej) => ws.end((err) => (err ? rej(err) : res())));
  fs.renameSync(tmp, outPath);

  log(`\nWrote ${rows} ranges to ${outPath}`);
  log('Point the server at it: GEOIP_DB_PATH=<path> (or Settings → Map → GeoIP database).');
}

main().catch((e) => die(e.message));
