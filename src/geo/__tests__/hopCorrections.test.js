'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHopCorrections } = require('../hopCorrections');
const { locateHop } = require('../hopLocation');

const rows = [
  { ip: '193.162.153.0', prefixLen: 24, lat: 55.6761, lng: 12.5683, city: 'Copenhagen', country: 'DK', source: 'manual', note: 'measured' },
  { ip: '193.162.153.9', prefixLen: 32, lat: 56.1629, lng: 10.2039, city: 'Aarhus', country: 'DK', source: 'manual' },
  { ip: '80.0.0.0', prefixLen: 8, lat: 52.3676, lng: 4.9041, city: null, country: 'NL', source: 'ripe' },
];

test('the longest matching prefix wins, the way routing works', () => {
  const store = createHopCorrections();
  store.load(rows);
  assert.equal(store.lookup('193.162.153.5').city, 'Copenhagen');
  assert.equal(store.lookup('193.162.153.9').city, 'Aarhus');
  assert.equal(store.lookup('80.1.2.3').country, 'NL');
  assert.equal(store.lookup('8.8.8.8'), null);
});

test('private addresses are never looked up', () => {
  const store = createHopCorrections();
  store.load([{ ip: '10.0.0.1', prefixLen: 32, lat: 1, lng: 2, source: 'manual' }]);
  assert.equal(store.lookup('10.0.0.1'), null);
});

test('garbage rows are dropped rather than indexed', () => {
  const store = createHopCorrections();
  store.load([null, {}, { ip: '1.2.3.4' }, { ip: '1.2.3.4', lat: 'x', lng: 2 }]);
  assert.equal(store.size(), 0);
  assert.equal(store.lookup('1.2.3.4'), null);
});

test('a correction beats every GeoIP source, whatever the reply time says', () => {
  const store = createHopCorrections();
  store.load(rows);
  // GeoIP says Australia, the city provider says Australia, the agent is in
  // Sydney — and the operator says Copenhagen. The operator wins, and the
  // placement is not downgraded to 'registration' by the distance.
  const out = locateHop({ ip: '193.162.153.5', rttMs: 1 }, {
    corrections: store,
    geoProvider: { lookup: () => ({ country: 'AU', asn: 1, asnName: 'AUNET' }) },
    cityProvider: { lookup: () => ({ city: 'Sydney', country: 'AU', lat: -33.86, lng: 151.2 }) },
    origin: { lat: -33.86, lng: 151.2 },
  });
  assert.equal(out.place.city, 'Copenhagen');
  assert.equal(out.place.source, 'manual');
  assert.equal(out.place.certainty, 'exact');
  assert.equal(out.place.note, 'measured');
  // The registration data is still reported — the correction moves the pin,
  // it does not rewrite who the address belongs to.
  assert.equal(out.country, 'AU');
  assert.equal(out.asn, 1);
  // And what it overrode is still on offer.
  assert.equal(out.alternatives[0].city, 'Sydney');
});

test('without a correction nothing changes', () => {
  const store = createHopCorrections();
  store.load(rows);
  const out = locateHop({ ip: '8.8.8.8', rttMs: 1 }, {
    corrections: store,
    cityProvider: { lookup: () => ({ city: 'Sydney', country: 'AU', lat: -33.86, lng: 151.2 }) },
    origin: { lat: -33.86, lng: 151.2 },
  });
  assert.equal(out.place.source, 'geoip-city');
});

test('reload without a repository empties the index instead of throwing', async () => {
  const store = createHopCorrections();
  store.load(rows);
  assert.equal(await store.reload(), 0);
  assert.equal(store.lookup('193.162.153.5'), null);
});

test('a failing repository keeps the index it already had', async () => {
  const warned = [];
  const store = createHopCorrections({
    repo: { all: async () => { throw new Error('db down'); } },
    logger: { warn: (o, m) => warned.push(m) },
  });
  store.load(rows);
  assert.equal(await store.reload(), 3);
  assert.equal(store.lookup('193.162.153.5').city, 'Copenhagen');
  assert.equal(warned.length, 1);
});

test('reload reads the repository and reports the size', async () => {
  const store = createHopCorrections({ repo: { all: async () => rows } });
  assert.equal(await store.reload(), 3);
  assert.equal(store.status().size, 3);
  assert.ok(store.status().loadedAt instanceof Date);
});
