'use strict';

const fs = require('fs');
const { ipv4ToInt } = require('./privateIp');

const silentLogger = { info() {}, warn() {}, error() {} };

// Pluggable, offline GeoIP/ASN provider. No third-party SDK and no network — it
// reads a local range table so deployments stay on-prem and EU-sourced. The
// recommended dataset is DB-IP Lite (db-ip.com, Belgium/EU, CC-BY-4.0); see
// docs/geo.md for how to produce the CSV. Tests inject `ranges` directly.
//
// CSV format (one range per line, IPv4 dotted or integer):
//   start_ip,end_ip,country[,asn[,asn_name]]
// Lines that don't start with a valid IP are treated as comments/headers.
//
//   const geo = createGeoProvider({ dbPath: '/data/geoip.csv' });
//   geo.lookup('8.8.8.8'); // -> { country, asn, asnName } | null

function parseCsv(text) {
  const ranges = [];
  if (typeof text !== 'string') return ranges;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map((c) => c.trim());
    const lo = /^\d+$/.test(cols[0]) ? Number(cols[0]) : ipv4ToInt(cols[0]);
    const hi = /^\d+$/.test(cols[1]) ? Number(cols[1]) : ipv4ToInt(cols[1]);
    if (lo === null || hi === null || Number.isNaN(lo) || Number.isNaN(hi)) continue; // header/comment
    ranges.push({
      lo,
      hi,
      country: cols[2] ? cols[2].toUpperCase() : null,
      asn: cols[3] ? Number(cols[3]) || null : null,
      asnName: cols[4] || null,
    });
  }
  return ranges;
}

function createGeoProvider({ ranges, csv, dbPath, logger = silentLogger } = {}) {
  let table = Array.isArray(ranges) ? ranges.slice() : [];

  if (!table.length && typeof csv === 'string') {
    table = parseCsv(csv);
  }
  if (!table.length && dbPath) {
    try {
      table = parseCsv(fs.readFileSync(dbPath, 'utf8'));
      logger.info(`geo: loaded ${table.length} IP ranges from ${dbPath}`);
    } catch (err) {
      logger.warn(`geo: could not read GeoIP database at ${dbPath} (${err.message}) — geo enrichment disabled`);
      table = [];
    }
  }

  // Sort by lower bound so we can binary-search.
  table.sort((a, b) => a.lo - b.lo);

  function lookup(ip) {
    const n = ipv4ToInt(ip);
    if (n === null || table.length === 0) return null; // IPv6/unknown: provider-dependent, not in the default reader
    // Rightmost range whose lo <= n, then verify hi >= n.
    let lo = 0;
    let hi = table.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (table[mid].lo <= n) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (found === -1) return null;
    const r = table[found];
    if (n > r.hi) return null;
    return { country: r.country, asn: r.asn, asnName: r.asnName };
  }

  return { lookup, size: table.length };
}

module.exports = { createGeoProvider, parseCsv };
