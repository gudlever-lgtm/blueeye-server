'use strict';

// The path severity order is written TWICE — once in the analysis
// (src/analysis/pathGraph.js SEVERITY_RANK) and once in the dashboard
// (public/views/destinations.js RANK), because the dashboard is vanilla browser
// JS with no build step and cannot import the server's copy.
//
// They drifted. The dashboard ranked `muted` ABOVE `ok`, so on a healthy path
// whose only non-ok hop was a silent router — which is most paths, routers
// commonly do not emit ICMP "TTL exceeded" — the dashboard named that router
// the worst hop and drew it in the warning colour, under a sentence ending
// "(silent router — normal)". The server's own graph disagreed on the same
// data: it left worstHopIndex null.
//
// `muted` is not a degree of badness. It means NOT MEASURED, and it has to sit
// below `ok` or the most ordinary path there is reads as a fault.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { SEVERITY_RANK, WORST_MIN_RANK, buildPathGraph } = require('../src/analysis/pathGraph');

const viewSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'destinations.js'), 'utf8');

// Reads the dashboard's literal table out of its source. Parsing rather than
// importing: RANK is a local inside create(deps), and the point is to pin the
// value a reader of that file sees.
function dashboardRank() {
  const m = viewSrc.match(/var RANK = \{([^}]*)\};/);
  assert.ok(m, 'RANK literal not found in public/views/destinations.js');
  const out = {};
  for (const part of m[1].split(',')) {
    const kv = part.trim().match(/^(\w+)\s*:\s*(\d+)$/);
    if (kv) out[kv[1]] = Number(kv[2]);
  }
  return out;
}

test('the dashboard severity order matches the analysis, key for key', () => {
  assert.deepEqual(dashboardRank(), { ...SEVERITY_RANK }, 'public/views/destinations.js RANK drifted from src/analysis/pathGraph.js SEVERITY_RANK');
});

test('muted ranks below ok — it means not measured, not mildly bad', () => {
  assert.ok(SEVERITY_RANK.muted < SEVERITY_RANK.ok, 'a silent router must not outrank a healthy hop');
  assert.ok(SEVERITY_RANK.ok < SEVERITY_RANK.warn);
  assert.ok(SEVERITY_RANK.warn < SEVERITY_RANK.bad);
});

test('the dashboard uses the same floor for naming a worst hop as the analysis', () => {
  assert.ok(/var WORST_MIN_RANK = RANK\.warn;/.test(viewSrc), 'the dashboard must gate the worst-hop note on the same floor');
  assert.ok(/\(RANK\[worst\.severity\] \|\| 0\) >= WORST_MIN_RANK/.test(viewSrc), 'the worst-hop note must use the floor, not > 0');
  assert.equal(WORST_MIN_RANK, SEVERITY_RANK.warn);
});

// --- the behaviour the drift broke, asserted on the real graph --------------

const geoProvider = { lookup: () => null };
const centroids = { get: () => null };
// Same shape the analysis' own tests use: a stored traceroute result.
const run = (ts, hops, target = 'us.example.com') => ({ type: 'traceroute', target, ts, hops });

test('a healthy path with a silent router has NO worst hop', () => {
  const g = buildPathGraph([
    run('2026-06-09T10:00:00Z', [
      { hop: 1, ip: '10.0.0.1', sent: 3, recv: 3, lossPct: 0, rttMs: 1 },
      { hop: 2, ip: '81.19.0.1', sent: 3, recv: 3, lossPct: 0, rttMs: 9 },
      { hop: 3, ip: null, sent: 3, recv: 0, lossPct: 100, rttMs: null },
      { hop: 4, ip: '151.101.3.5', sent: 3, recv: 3, lossPct: 0, rttMs: 3 },
    ]),
  ], { geoProvider, centroids });

  const silent = g.nodes.find((n) => n.hop === 3);
  assert.equal(silent.severity, 'muted');
  assert.equal(g.worstHopIndex, null, 'a silent router on an otherwise healthy path is not a worst hop');
});

test('a genuinely bad hop is still named', () => {
  const g = buildPathGraph([
    run('2026-06-09T10:00:00Z', [
      { hop: 1, ip: '10.0.0.1', sent: 3, recv: 3, lossPct: 0, rttMs: 1 },
      { hop: 2, ip: null, sent: 3, recv: 0, lossPct: 100, rttMs: null },
      { hop: 3, ip: '81.19.0.9', sent: 10, recv: 4, lossPct: 60, rttMs: 300 },
    ]),
  ], { geoProvider, centroids });

  const bad = g.nodes.find((n) => n.hop === 3);
  assert.equal(bad.severity, 'bad');
  assert.equal(g.worstHopIndex, bad.index, 'the silent hop must not hide a real one');
});

// --- approximate placement --------------------------------------------------
//
// A country centroid stands for a country, not a spot in it. Testing it as a
// point called ordinary transit routers anycast: a DE-registered hop seen from
// Denmark in 2.77 ms was measured against the middle of Germany (465 km, just
// over its 437 km budget) and dropped, although Hamburg is 272 km away and
// comfortably inside the same budget.

const { locateHop, countryReachKm, DEFAULT_COUNTRY_REACH_KM } = require('../src/geo/hopLocation');

const DK_AGENT = { lat: 56, lng: 10 };
const centroidsFor = (table) => ({ get: (c) => table[c] || null });
const CENTROIDS = centroidsFor({ DE: { lat: 51.2, lng: 10.4 }, US: { lat: 39.8, lng: -98.6 }, FI: { lat: 64.9, lng: 26 } });
const geoFor = (country) => ({ lookup: () => ({ country, asn: 1, asnName: 'X' }) });

test('a near miss on a country centroid is placed, and marked approximate', () => {
  const hop = locateHop({ ip: '213.239.240.33', rttMs: 2.77 }, { geoProvider: geoFor('DE'), centroids: CENTROIDS, origin: DK_AGENT });
  assert.equal(hop.country, 'DE');
  assert.ok(Number.isFinite(hop.lat), 'it is drawn rather than dropped — a hole in the path reads as a broken trace');
  assert.equal(hop.place.certainty, 'approximate');
  assert.ok(hop.place.offByKm > 0, 'and says how far past the budget the pin sits');
  assert.equal(hop.rejected, null, 'a feasible country is not a rejection');
});

test('an order-of-magnitude miss is still refused, and reports what IS known', () => {
  const hop = locateHop({ ip: '76.223.85.0', rttMs: 5.74 }, { geoProvider: geoFor('US'), centroids: CENTROIDS, origin: DK_AGENT });
  assert.equal(hop.lat, null, 'no part of the US is within 724 km of Denmark — drawing it there would be false');
  assert.equal(hop.place, null);
  assert.ok(hop.rejected.length);
  assert.equal(hop.withinKm, 724, 'the reply time still bounds it, and that bound is the only true thing left to say');
});

test('a hop the check accepts outright is exact, not approximate', () => {
  const hop = locateHop({ ip: '81.19.0.1', rttMs: 9 }, { geoProvider: geoFor('DE'), centroids: CENTROIDS, origin: DK_AGENT });
  assert.equal(hop.place.certainty, 'exact');
  assert.equal(hop.place.offByKm, undefined);
});

test('an exact candidate always wins over an approximate one', () => {
  // rDNS says Hamburg (close, feasible); GeoIP country says DE (centroid, a
  // near miss). The precise, feasible candidate must be the one drawn.
  const hop = locateHop(
    { ip: '213.239.240.33', hostname: 'ham-core1.example.net', rttMs: 2.77 },
    { geoProvider: geoFor('DE'),
      cityProvider: { lookup: () => ({ city: 'Hamburg', country: 'DE', lat: 53.55, lng: 9.99 }) },
      centroids: CENTROIDS,
      origin: DK_AGENT },
  );
  assert.equal(hop.place.certainty, 'exact');
  assert.equal(hop.place.city, 'Hamburg');
});

test('country reach is per country, with a default for the rest', () => {
  assert.ok(countryReachKm('US') > countryReachKm('DE'), 'a centroid is more wrong for a big country');
  assert.equal(countryReachKm('DE'), DEFAULT_COUNTRY_REACH_KM);
  assert.equal(countryReachKm(null), DEFAULT_COUNTRY_REACH_KM);
  assert.equal(countryReachKm('zz'), DEFAULT_COUNTRY_REACH_KM, 'an unknown code gets the default, never zero');
});

test('the extra reach only ever adds tolerance — it cannot move a hop', () => {
  const near = locateHop({ ip: '1.1.1.1', rttMs: 60 }, { geoProvider: geoFor('DE'), centroids: CENTROIDS, origin: DK_AGENT });
  assert.equal(near.lat, 51.2, 'a comfortably feasible hop is placed exactly where it was before');
  assert.equal(near.place.certainty, 'exact');
});

test('no origin means nothing can be checked, and nothing is rejected', () => {
  const hop = locateHop({ ip: '76.223.85.0', rttMs: 5.74 }, { geoProvider: geoFor('US'), centroids: CENTROIDS, origin: null });
  assert.ok(Number.isFinite(hop.lat), 'without the agent site there is no bound to apply');
  assert.equal(hop.place.certainty, 'exact');
  assert.equal(hop.withinKm, null);
});
