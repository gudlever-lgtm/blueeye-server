'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDestinationPlacer, sharedNetworkOf } = require('../destinationPlace');

// A city table that answers for one address and nothing else.
const cityProvider = (hit) => ({ lookup: (ip) => (ip === '203.0.113.9' ? hit : null) });
const MONTREAL = { city: 'Montreal', country: 'CA', lat: 45.5, lng: -73.57 };

test('places a destination on its city when both databases agree', () => {
  const placer = createDestinationPlacer({ cityProvider: cityProvider(MONTREAL) });
  const p = placer.place('203.0.113.9', { country: 'CA', asn: 852, asnName: 'TELUS' });
  assert.deepEqual(p, { city: 'Montreal', lat: 45.5, lng: -73.57 });
});

test('refuses the city when the two databases name different countries', () => {
  const placer = createDestinationPlacer({ cityProvider: cityProvider({ ...MONTREAL, country: 'US' }) });
  assert.equal(placer.place('203.0.113.9', { country: 'CA', asn: 852, asnName: 'TELUS' }), null);
});

test('refuses the city for clouds and anycast CDNs — one address, many sites', () => {
  const placer = createDestinationPlacer({ cityProvider: cityProvider(MONTREAL) });
  const cases = [
    { asn: 13335, asnName: 'CLOUDFLARENET' },
    { asn: 16509, asnName: 'AMAZON-02' },
    { asn: 54113, asnName: 'FASTLY' },
    { asn: 999999, asnName: 'Akamai Technologies' },
  ];
  for (const sel of cases) {
    assert.equal(placer.place('203.0.113.9', { country: 'CA', ...sel }), null, `${sel.asnName} must stay at country level`);
  }
});

test('an unknown address, a missing country or no city table stays at country level', () => {
  const placer = createDestinationPlacer({ cityProvider: cityProvider(MONTREAL) });
  assert.equal(placer.place('198.51.100.1', { country: 'CA', asn: 852 }), null);
  assert.equal(placer.place('203.0.113.9', { country: null, asn: 852 }), null);
  assert.equal(createDestinationPlacer({}).place('203.0.113.9', { country: 'CA', asn: 852 }), null);
});

test('a city table that throws or answers without a usable point never breaks placement', () => {
  const thrower = { lookup: () => { throw new Error('index not loaded'); } };
  assert.equal(createDestinationPlacer({ cityProvider: thrower }).place('203.0.113.9', { country: 'CA' }), null);
  const noPoint = cityProvider({ city: 'Montreal', country: 'CA', lat: null, lng: null });
  assert.equal(createDestinationPlacer({ cityProvider: noPoint }).place('203.0.113.9', { country: 'CA' }), null);
  const noCity = cityProvider({ city: '', country: 'CA', lat: 45.5, lng: -73.57 });
  assert.equal(createDestinationPlacer({ cityProvider: noCity }).place('203.0.113.9', { country: 'CA' }), null);
});

test('sharedNetworkOf names the network that made us stand down, or nothing', () => {
  assert.equal(sharedNetworkOf(13335, 'CLOUDFLARENET'), 'Cloudflare');
  assert.equal(sharedNetworkOf(24940, 'Hetzner Online GmbH'), 'Hetzner');
  assert.equal(sharedNetworkOf(852, 'TELUS Communications'), null);
});
