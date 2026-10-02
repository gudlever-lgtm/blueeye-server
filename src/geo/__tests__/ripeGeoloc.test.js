'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseRipeInetnums, parseGeoloc, rangeToCidrs } = require('../ripeGeoloc');

test('a geoloc value is "lat lng" in decimal degrees', () => {
  assert.deepEqual(parseGeoloc('55.6761 12.5683'), { lat: 55.6761, lng: 12.5683 });
  assert.deepEqual(parseGeoloc('-33.86, 151.2'), { lat: -33.86, lng: 151.2 });
  assert.equal(parseGeoloc('55.6761'), null);
  assert.equal(parseGeoloc('somewhere in Denmark'), null);
  assert.equal(parseGeoloc('91 12'), null);
  // A half-filled template leaves 0 0 behind, in the Atlantic.
  assert.equal(parseGeoloc('0 0'), null);
  assert.equal(parseGeoloc(null), null);
});

test('a range becomes the prefixes that exactly cover it, never wider', () => {
  assert.deepEqual(rangeToCidrs('193.162.153.0 - 193.162.153.255'), [{ ip: '193.162.153.0', prefixLen: 24 }]);
  assert.deepEqual(rangeToCidrs('1.2.3.0 - 1.2.4.255'), [
    { ip: '1.2.3.0', prefixLen: 24 }, { ip: '1.2.4.0', prefixLen: 24 },
  ]);
  // Not a round block: covered exactly, so no address the holder never
  // claimed is moved.
  assert.deepEqual(rangeToCidrs('1.2.3.0 - 1.2.3.127'), [{ ip: '1.2.3.0', prefixLen: 25 }]);
  assert.deepEqual(rangeToCidrs('1.2.3.4 - 1.2.3.4'), [{ ip: '1.2.3.4', prefixLen: 32 }]);
  assert.deepEqual(rangeToCidrs('1.2.3.9 - 1.2.3.1'), []);
  assert.deepEqual(rangeToCidrs('nonsense'), []);
});

test('a block wider than /8 is dropped', () => {
  assert.deepEqual(rangeToCidrs('16.0.0.0 - 31.255.255.255'), []);
});

const FILE = `% RIPE database

inetnum:        193.162.153.0 - 193.162.153.255
netname:        EXAMPLE-NET
country:        DK
geoloc:         55.6761 12.5683
source:         RIPE

inetnum:        5.5.5.0 - 5.5.5.255
netname:        NO-COORDS
country:        DE

inetnum:        192.168.0.0 - 192.168.0.255
country:        DK
geoloc:         55.0 12.0
`;

test('only records with usable coordinates are imported', () => {
  const rows = parseRipeInetnums(FILE);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    ip: '193.162.153.0', prefixLen: 24, lat: 55.6761, lng: 12.5683,
    city: null, country: 'DK', source: 'ripe', note: 'RIPE geoloc',
  });
});

test('a registry record for private space never reaches the geo layer', () => {
  assert.equal(parseRipeInetnums(FILE).some((r) => r.ip.startsWith('192.168.')), false);
});

test('garbage input yields nothing rather than throwing', () => {
  assert.deepEqual(parseRipeInetnums(''), []);
  assert.deepEqual(parseRipeInetnums(null), []);
  assert.deepEqual(parseRipeInetnums('geoloc: nonsense'), []);
});
