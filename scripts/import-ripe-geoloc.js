#!/usr/bin/env node
'use strict';

// Imports `geoloc:` coordinates from a RIPE NCC database split file into
// `hop_locations` (migration 144) — the table the path maps consult BEFORE any
// GeoIP source. See src/geo/ripeGeoloc.js for what the attribute is and why it
// is worth more than a range file.
//
//   node scripts/import-ripe-geoloc.js /path/to/ripe.db.inetnum.gz
//   node scripts/import-ripe-geoloc.js --dry-run ripe.db.inetnum
//
// The file comes from the RIPE NCC FTP (ftp.ripe.net/ripe/dbase/split/), is
// read as a stream (the uncompressed file is gigabytes), and is parsed locally
// — no API call, no US vendor, nothing leaves the server.
//
// Existing rows are never overwritten: INSERT IGNORE, so a manual correction
// always wins over what the registry says about the block around it.

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const mysql = require('mysql2/promise');
const { config } = require('../src/config');
const { parseRipeInetnums } = require('../src/geo/ripeGeoloc');
const { createHopLocationsRepository } = require('../src/repositories/hopLocationsRepository');

// Records are flushed in batches rather than collected: the input is huge and
// only a small fraction of it carries coordinates, but "small fraction of huge"
// is still too much to hold.
const BATCH = 2000;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    process.stderr.write('usage: import-ripe-geoloc.js [--dry-run] <ripe.db.inetnum[.gz]>\n');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    process.stderr.write(`no such file: ${file}\n`);
    process.exit(2);
  }

  const pool = dryRun ? null : mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    connectionLimit: 2,
  });
  const repo = pool ? createHopLocationsRepository({ pool }) : null;

  let stream = fs.createReadStream(file);
  if (file.endsWith('.gz')) stream = stream.pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let record = [];
  let pending = [];
  let parsed = 0;
  let written = 0;

  async function flush(force = false) {
    if (!pending.length || (!force && pending.length < BATCH)) return;
    parsed += pending.length;
    if (repo) written += await repo.insertManyIgnore(pending);
    pending = [];
  }

  for await (const line of rl) {
    if (line.trim() === '') {
      if (record.length) {
        for (const row of parseRipeInetnums(record.join('\n'))) pending.push(row);
        record = [];
      }
      await flush();
    } else {
      record.push(line);
    }
  }
  if (record.length) for (const row of parseRipeInetnums(record.join('\n'))) pending.push(row);
  await flush(true);

  process.stdout.write(dryRun
    ? `dry run: ${parsed} geoloc prefixes found in ${file}\n`
    : `imported ${written} new of ${parsed} geoloc prefixes from ${file}\n`);
  if (pool) await pool.end();
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
