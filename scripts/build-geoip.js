#!/usr/bin/env node
'use strict';

// Builds the offline GeoIP/ASN range CSV that the server's geo provider reads
// (GEOIP_DB_PATH, or Settings → Map → GeoIP database). It converts the EU-sourced
// DB-IP Lite files (db-ip.com, Belgium, CC-BY-4.0) into the provider's format:
//
//   start_ip,end_ip,country[,asn[,asn_name]]
//
// IPv4 only. The build logic is shared with the in-app updater (Settings → Map →
// "Update now") via src/geo/geoipBuild.js, so the two never drift.
//
// Usage:
//   node scripts/build-geoip.js --country dbip-country-lite.csv[.gz] \
//        [--asn dbip-asn-lite.csv[.gz]] [--out geoip.csv]
//   node scripts/build-geoip.js --country-url <URL> [--asn-url <URL>] [--out geoip.csv]
//   node scripts/build-geoip.js --latest [--country-only] [--out geoip.csv]
//
// --latest fetches the current-month DB-IP Lite files from db-ip.com (override the
// base with --base-url). Inputs may be plain CSV or gzip (.gz, auto-detected); with
// *-url they're streamed over HTTPS. Node stdlib only — no dependency.
//
// Lite files (free, monthly): https://db-ip.com/db/lite.php

const { buildFromSources, dbipUrls, monthCandidates, openSource, DEFAULT_DBIP_BASE } = require('../src/geo/geoipBuild');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--latest' || a === '--country-only') { out[a.slice(2)] = true; continue; }
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

function die(msg) { process.stderr.write(`ERROR: ${msg}\n`); process.exit(1); }
function log(msg) { process.stderr.write(`${msg}\n`); }

// Picks the first month whose country file exists (open then close the stream).
// Returns the resolved sources, or throws when neither month is published.
async function resolveLatest(baseUrl, includeAsn) {
  for (const month of monthCandidates()) {
    const urls = dbipUrls(baseUrl, month);
    try {
      const s = await openSource({ url: urls.country });
      s.destroy();
      return { month, country: { url: urls.country }, asn: includeAsn ? { url: urls.asn } : null };
    } catch { /* try the previous month */ }
  }
  throw new Error('could not find a published DB-IP Lite file for this or last month');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.country && !args['country-url'] && !args.latest)) {
    log('Build the server GeoIP CSV from DB-IP Lite files (IPv4, EU-sourced).\n');
    log('  node scripts/build-geoip.js --country <file.csv[.gz]> [--asn <file.csv[.gz]>] [--out geoip.csv]');
    log('  node scripts/build-geoip.js --country-url <URL> [--asn-url <URL>] [--out geoip.csv]');
    log('  node scripts/build-geoip.js --latest [--country-only] [--base-url <URL>] [--out geoip.csv]\n');
    log('Get the Lite CSVs from https://db-ip.com/db/lite.php (CC-BY-4.0).');
    process.exit(args.help ? 0 : 1);
  }
  const out = args.out || 'geoip.csv';

  let sources;
  if (args.latest) {
    log('Resolving the latest DB-IP Lite release…');
    const r = await resolveLatest(args['base-url'] || DEFAULT_DBIP_BASE, !args['country-only']).catch((e) => die(e.message));
    log(`  using ${r.month}`);
    sources = { country: r.country, asn: r.asn };
  } else {
    sources = {
      country: args.country ? { file: args.country } : { url: args['country-url'] },
      asn: (args.asn || args['asn-url']) ? (args.asn ? { file: args.asn } : { url: args['asn-url'] }) : null,
    };
  }

  log('Building…');
  const { rows, countryRanges, asnRanges } = await buildFromSources({ ...sources, out })
    .catch((e) => die(e.message));
  log(`  ${countryRanges} country ranges, ${asnRanges} ASN ranges`);
  log(`\nWrote ${rows} ranges to ${out}`);
  log('Point the server at it: GEOIP_DB_PATH=<path> (or Settings → Map → GeoIP database).');
}

main().catch((e) => die(e.message));
