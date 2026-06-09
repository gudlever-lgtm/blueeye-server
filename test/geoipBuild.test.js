'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildFromSources, dbipUrls, monthCandidates } = require('../src/geo/geoipBuild');

function tmp(name, content) {
  const p = path.join(os.tmpdir(), `geoipbuild-${process.pid}-${name}`);
  fs.writeFileSync(p, content);
  return p;
}
const rows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));

test('buildFromSources range-joins ASN onto country (covered span + gap)', async () => {
  const country = tmp('c.csv', '8.8.8.0,8.8.8.255,US\n80.0.0.0,80.255.255.255,DE\n');
  const asn = tmp('a.csv', '8.8.8.0,8.8.8.127,15169,"Google LLC"\n');
  const out = tmp('out.csv', '');
  const r = await buildFromSources({ country: { file: country }, asn: { file: asn }, out });
  assert.equal(r.countryRanges, 2);
  assert.equal(r.asnRanges, 1);
  // 8.8.8.0–127 US+ASN, 8.8.8.128–255 US-only (ASN gap), 80/8 DE-only.
  assert.deepEqual(rows(out), [
    '8.8.8.0,8.8.8.127,US,15169,Google LLC',
    '8.8.8.128,8.8.8.255,US',
    '80.0.0.0,80.255.255.255,DE',
  ]);
  [country, asn, out].forEach((p) => fs.unlinkSync(p));
});

test('buildFromSources is country-only when no ASN source', async () => {
  const country = tmp('c2.csv', '1.0.0.0,1.0.0.255,AU\n');
  const out = tmp('out2.csv', '');
  const r = await buildFromSources({ country: { file: country }, asn: null, out });
  assert.equal(r.asnRanges, 0);
  assert.deepEqual(rows(out), ['1.0.0.0,1.0.0.255,AU']);
  [country, out].forEach((p) => fs.unlinkSync(p));
});

test('buildFromSources skips IPv6 rows (IPv4-only reader)', async () => {
  const country = tmp('c3.csv', '2001:db8::,2001:db8::ffff,DE\n9.9.9.0,9.9.9.255,CH\n');
  const out = tmp('out3.csv', '');
  const r = await buildFromSources({ country: { file: country }, out });
  assert.equal(r.countryRanges, 1);
  assert.deepEqual(rows(out), ['9.9.9.0,9.9.9.255,CH']);
  [country, out].forEach((p) => fs.unlinkSync(p));
});

test('writeCsv creates the target dir and keeps the temp file beside the output', async () => {
  // Regression: the temp file must live in the OUTPUT dir, not os.tmpdir(), or the
  // rename crosses filesystems (EXDEV) in Docker (/tmp → the /data volume).
  const base = path.join(os.tmpdir(), `geoipbuild-${process.pid}-nested-${Date.now()}`);
  const out = path.join(base, 'sub', 'geoip.csv'); // dir does not exist yet
  const country = tmp('cdir.csv', '5.5.5.0,5.5.5.255,SE\n');
  const r = await buildFromSources({ country: { file: country }, out });
  assert.equal(r.rows, 1);
  assert.ok(fs.existsSync(out)); // mkdir -p happened + file landed
  assert.deepEqual(rows(out), ['5.5.5.0,5.5.5.255,SE']);
  // no leftover temp files in the target dir
  assert.deepEqual(fs.readdirSync(path.dirname(out)).filter((f) => f.startsWith('.geoip-')), []);
  fs.rmSync(base, { recursive: true, force: true });
  fs.unlinkSync(country);
});

test('dbipUrls + monthCandidates build paths and fall back a month (incl. year rollover)', () => {
  const u = dbipUrls('https://x/free/', '2026-06');
  assert.equal(u.country, 'https://x/free/dbip-country-lite-2026-06.csv.gz');
  assert.equal(u.asn, 'https://x/free/dbip-asn-lite-2026-06.csv.gz');
  assert.deepEqual(monthCandidates(new Date(Date.UTC(2026, 5, 9))), ['2026-06', '2026-05']);
  assert.deepEqual(monthCandidates(new Date(Date.UTC(2026, 0, 3))), ['2026-01', '2025-12']);
});
