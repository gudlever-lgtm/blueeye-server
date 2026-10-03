'use strict';

// The two halves of "GeoIP is wrong about this hop": the path noticing it, and
// an operator writing down the answer. End to end through buildPathGraph, so
// the wiring is covered as well as the maths.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPathGraph, describeLiveHop, createLiveTraces } = require('../src/analysis/pathGraph');
const { createCentroids } = require('../src/geo/centroids');
const { createHopCorrections } = require('../src/geo/hopCorrections');

const CPH = { lat: 55.6761, lng: 12.5683 };
const centroids = createCentroids();

// The case this exists for: three hops 1 ms apart, all in one Copenhagen
// building, and the middle one's block is registered in Singapore. The map drew
// a line to Singapore and back.
const cityProvider = {
  lookup: (ip) => {
    if (ip === '10.1.1.1') return null;
    if (ip === '1.0.0.2') return { city: 'Singapore', country: 'SG', lat: 1.3521, lng: 103.8198 };
    return { city: 'Copenhagen', country: 'DK', lat: 55.6761, lng: 12.5683 };
  },
};
const geoProvider = { lookup: (ip) => ({ country: ip === '1.0.0.2' ? 'SG' : 'DK', asn: 3292, asnName: 'TDC' }) };

const HOPS = [
  { hop: 1, ip: '1.0.0.1', rttMs: 1 },
  { hop: 2, ip: '1.0.0.2', rttMs: 2 },
  { hop: 3, ip: '1.0.0.3', rttMs: 3 },
];
const run = (hops = HOPS) => ({ type: 'traceroute', target: 'example.dk', ts: '2026-10-01T10:00:00Z', ok: true, hops });

test('the graph reports the hop its neighbours disagree with', () => {
  const g = buildPathGraph([run()], { geoProvider, cityProvider, centroids, origin: CPH });
  assert.equal(g.suspectHops.length, 1);
  assert.equal(g.suspectHops[0].hop, 2);
  assert.equal(g.suspectHops[0].ip, '1.0.0.2');
  assert.equal(g.suspectHops[0].suggestion.city, 'Copenhagen');
  const hop2 = g.nodes.find((n) => n.hop === 2);
  assert.equal(hop2.place.suspect.reason, 'neighbours');
  // Still drawn where GeoIP put it — the mark is the output, not a move.
  assert.equal(hop2.place.city, 'Singapore');
  assert.equal(hop2.lat, 1.3521);
});

test('a correction replaces it, and the hop stops being suspect', () => {
  const corrections = createHopCorrections();
  corrections.load([{ ip: '1.0.0.0', prefixLen: 24, lat: 55.6761, lng: 12.5683, city: 'Copenhagen', country: 'DK', source: 'manual', note: 'measured from HQ' }]);
  const g = buildPathGraph([run()], { geoProvider, cityProvider, centroids, corrections, origin: CPH });
  const hop2 = g.nodes.find((n) => n.hop === 2);
  assert.equal(hop2.place.source, 'manual');
  assert.equal(hop2.place.city, 'Copenhagen');
  assert.equal(hop2.place.note, 'measured from HQ');
  assert.equal(hop2.lat, 55.6761);
  assert.deepEqual(g.suspectHops, []);
  // The address still belongs where it is registered — the pin moved, not the
  // registration.
  assert.equal(hop2.country, 'SG');
});

test('a correction travels into the live hop stream too', () => {
  const corrections = createHopCorrections();
  corrections.load([{ ip: '1.0.0.2', prefixLen: 32, lat: 55.6761, lng: 12.5683, city: 'Copenhagen', country: 'DK', source: 'ripe' }]);
  const node = describeLiveHop({ hop: 2, ip: '1.0.0.2', rttMs: 2, minMs: 2 }, { geoProvider, cityProvider, centroids, corrections, origin: CPH });
  assert.equal(node.place.source, 'ripe');
  assert.equal(node.place.city, 'Copenhagen');
});

test('a live trace marks the hop once the hop after it has replied', () => {
  const traces = createLiveTraces();
  const live = (h) => traces.settle('a|traceroute|example.dk', describeLiveHop(h, { geoProvider, cityProvider, centroids, origin: CPH }), CPH);
  live({ hop: 1, ip: '1.0.0.1', rttMs: 1, minMs: 1 });
  // Nothing to compare it against yet: the hop after it has not answered.
  assert.equal(live({ hop: 2, ip: '1.0.0.2', rttMs: 2, minMs: 2 }).place.suspect, undefined);
  live({ hop: 3, ip: '1.0.0.3', rttMs: 3, minMs: 3 });
  const again = live({ hop: 2, ip: '1.0.0.2', rttMs: 2, minMs: 2 });
  assert.equal(again.place.suspect.reason, 'neighbours');
});

test('a path nobody has corrected is unchanged by an empty table', () => {
  const corrections = createHopCorrections();
  const a = buildPathGraph([run()], { geoProvider, cityProvider, centroids, origin: CPH });
  const b = buildPathGraph([run()], { geoProvider, cityProvider, centroids, corrections, origin: CPH });
  assert.deepEqual(b.nodes.map((n) => [n.lat, n.lng]), a.nodes.map((n) => [n.lat, n.lng]));
});
