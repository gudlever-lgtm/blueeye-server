'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createGeoProvider, parseCsv } = require('../provider');
const { ipv4ToInt } = require('../privateIp');

const RANGES = [
  { lo: ipv4ToInt('1.1.1.0'), hi: ipv4ToInt('1.1.1.255'), country: 'AU', asn: 13335, asnName: 'CLOUDFLARE' },
  { lo: ipv4ToInt('8.8.8.0'), hi: ipv4ToInt('8.8.8.255'), country: 'US', asn: 15169, asnName: 'GOOGLE' },
  { lo: ipv4ToInt('80.0.0.0'), hi: ipv4ToInt('80.255.255.255'), country: 'DE', asn: 3320, asnName: 'DTAG' },
];

test('lookup finds the right range via binary search', () => {
  const geo = createGeoProvider({ ranges: RANGES });
  assert.deepEqual(geo.lookup('8.8.8.8'), { country: 'US', asn: 15169, asnName: 'GOOGLE' });
  assert.deepEqual(geo.lookup('1.1.1.200'), { country: 'AU', asn: 13335, asnName: 'CLOUDFLARE' });
  assert.equal(geo.lookup('80.10.20.30').country, 'DE');
});

test('lookup misses return null (gaps, IPv6, empty table)', () => {
  const geo = createGeoProvider({ ranges: RANGES });
  assert.equal(geo.lookup('9.9.9.9'), null);
  assert.equal(geo.lookup('2001:4860:4860::8888'), null);
  assert.equal(createGeoProvider({}).lookup('8.8.8.8'), null);
});

test('parseCsv reads ranges, skips headers/comments, ASN optional', () => {
  const csv = [
    '# a comment',
    'start,end,country,asn,name',  // header -> first col not an IP/int -> skipped
    '8.8.8.0,8.8.8.255,US,15169,GOOGLE',
    '80.0.0.0,80.255.255.255,DE',  // no ASN
  ].join('\n');
  const ranges = parseCsv(csv);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].country, 'US');
  assert.equal(ranges[0].asn, 15169);
  assert.equal(ranges[1].country, 'DE');
  assert.equal(ranges[1].asn, null);
});

test('a missing GeoIP database disables enrichment without throwing', () => {
  const geo = createGeoProvider({ dbPath: '/no/such/geoip-file.csv' });
  assert.equal(geo.size, 0);
  assert.equal(geo.lookup('8.8.8.8'), null);
});

test('provider loads ranges from a CSV string', () => {
  const geo = createGeoProvider({ csv: '8.8.8.0,8.8.8.255,US,15169,GOOGLE' });
  assert.equal(geo.lookup('8.8.8.8').asn, 15169);
});
