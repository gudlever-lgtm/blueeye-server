'use strict';

// Traceroute hops on the map: the router's own name first, city GeoIP second,
// the country centroid last — every one checked against the hop's RTT.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const { placeFromHostname, cleanHostname, hostLabels } = require('../src/geo/hostnameHints');
const { PLACES } = require('../src/geo/networkPlaces');
const { locateHop, feasible, haversineKm, maxDistanceKm } = require('../src/geo/hopLocation');
const { createCityProvider, parseRow } = require('../src/geo/cityProvider');
const { buildCityFromSource, dbipUrls } = require('../src/geo/geoipBuild');
const { createGeoipUpdater } = require('../src/geo/geoipUpdater');
const { createSettingsService } = require('../src/services/settings');
const { buildPathGraph, describeLiveHop } = require('../src/analysis/pathGraph');
const { traceHopPayload } = require('../src/ws/agentSocket');
const { validateProbeResults } = require('../src/validation/probeValidation');
const {
  makeApp, makeAgentsRepo, makeProbeResultsRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');

const CPH = { lat: 55.6761, lng: 12.5683 };
const centroids = {
  get: (c) => ({ DK: { lat: 56, lng: 10 }, SE: { lat: 62, lng: 15 }, DE: { lat: 51, lng: 10 }, US: { lat: 39.8, lng: -98.6 } }[c] || null),
};
const geoProvider = {
  lookup: (ip) => ({
    '62.115.1.1': { country: 'SE', asn: 1299, asnName: 'ARELION' },
    '154.54.1.1': { country: 'US', asn: 174, asnName: 'COGENT' },
    '8.8.8.8': { country: 'US', asn: 15169, asnName: 'GOOGLE' },
    '80.1.1.1': { country: 'DE', asn: 3320, asnName: 'DTAG' },
  }[ip] || null),
};

// ---- hostname hints --------------------------------------------------------

test('router names from the big carriers resolve to their city', () => {
  const cases = {
    'ae3.cph-bb1.telia.net': 'Copenhagen',
    'kbn-bb6-link.ip.twelve99.net': 'Copenhagen',
    'ffm-bb2-link.ip.twelve99.net': 'Frankfurt',
    'be2376.ccr41.fra03.atlas.cogentco.com': 'Frankfurt',
    'ae-5.r20.frnkge08.de.bb.gin.ntt.net': 'Frankfurt',
    'core1.ams1.he.net': 'Amsterdam',
    'xe-0-0-0.cr1-sto1.ip4.gtt.net': 'Stockholm',
    'server-18-66-1-2.fra56.r.cloudfront.net': 'Frankfurt',
    'xe-1.dkcph1.example.net': 'Copenhagen',
    'ae1.lon2.example.co.uk': 'London',
  };
  for (const [name, city] of Object.entries(cases)) {
    const p = placeFromHostname(name);
    assert.ok(p, `${name} should resolve`);
    assert.equal(p.city, city, name);
  }
  assert.equal(placeFromHostname('ae3.cph-bb1.telia.net').code, 'cph');
});

test('a name without a place code, or with two different places, gives no place', () => {
  for (const name of [
    'static-82-103-1-2.customer.example.dk',
    'router.example.net',
    'edge.example.net',
    'ams-fra-link.example.net',  // the two ends of a link
    'fra.net',                   // the code IS the registered domain
    '', null, 42, '<script>.example.net',
  ]) {
    assert.equal(placeFromHostname(name), null, String(name));
  }
});

test('the operator domain is dropped before matching', () => {
  assert.deepEqual(hostLabels('ae3.cph-bb1.telia.net'), ['ae3', 'cph-bb1']);
  assert.deepEqual(hostLabels('a.b.example.co.uk'), ['a', 'b']);
  assert.deepEqual(hostLabels('example.net'), []);
  // "ams" is the domain here, not a place
  assert.equal(placeFromHostname('core1.edge.ams.net'), null);
});

test('cleanHostname accepts DNS names only', () => {
  assert.equal(cleanHostname('AE3.CPH-BB1.Telia.NET.'), 'ae3.cph-bb1.telia.net');
  assert.equal(cleanHostname('bad name.example'), null);
  assert.equal(cleanHostname('x'.repeat(254)), null);
  assert.equal(cleanHostname({}), null);
});

test('the place table is well-formed: unique codes, real coordinates, ISO countries', () => {
  const seen = new Map();
  for (const p of PLACES) {
    assert.match(p.country, /^[A-Z]{2}$/, p.city);
    assert.ok(Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180, p.city);
    for (const c of p.codes) {
      assert.match(c, /^[a-z]{3,}$/, `${p.city}: ${c}`);
      assert.ok(!seen.has(c), `code ${c} is used by both ${seen.get(c)} and ${p.city}`);
      seen.set(c, p.city);
    }
  }
  // Words a router name uses for something else must never be place codes.
  for (const w of ['bdr', 'cor', 'core', 'edge', 'tor', 'man', 'str', 'per', 'los', 'del', 'net', 'com', 'link', 'bb']) {
    assert.ok(!seen.has(w), `${w} must not be a place code`);
  }
});

// ---- the speed-of-light check ---------------------------------------------

test('haversine and the RTT bound', () => {
  const fra = { lat: 50.1109, lng: 8.6821 };
  const km = haversineKm(CPH, fra);
  assert.ok(km > 670 && km < 700, String(km));
  assert.equal(maxDistanceKm(10), 1150);
  assert.equal(feasible(CPH, fra, 10), true);
  assert.equal(feasible(CPH, fra, 2), false);
  assert.equal(feasible(null, fra, 2), null, 'no origin: nothing can be checked');
  assert.equal(feasible(CPH, fra, null), null, 'no RTT: nothing can be checked');
});

// ---- locateHop -------------------------------------------------------------

test('the router name wins over GeoIP when it passes the RTT check', () => {
  const g = locateHop({ ip: '62.115.1.1', hostname: 'ae3.cph-bb1.telia.net', rttMs: 1.2 }, { geoProvider, centroids, origin: CPH });
  assert.equal(g.country, 'SE', 'the registration stays what GeoIP says');
  assert.equal(g.asn, 1299);
  assert.deepEqual(g.place, { city: 'Copenhagen', country: 'DK', precision: 'city', source: 'rdns', code: 'cph', certainty: 'exact' });
  assert.equal(g.lat, 55.6761);
  assert.equal(g.hostname, 'ae3.cph-bb1.telia.net');
  assert.equal(g.rejected, null);
});

test('a name the RTT rules out falls back to city GeoIP, then the country', () => {
  const cityProvider = { lookup: () => ({ city: 'Stockholm', country: 'SE', lat: 59.3293, lng: 18.0686 }) };
  // 1 ms from Copenhagen: Frankfurt (~680 km) is impossible as a point, and so
  // is Stockholm (~520 km). Both are CITIES — precise claims — so both are
  // rejected outright.
  const g = locateHop({ ip: '62.115.1.1', hostname: 'ffm-bb2-link.ip.twelve99.net', rttMs: 1 }, { geoProvider, cityProvider, centroids, origin: CPH });
  assert.deepEqual(g.rejected.map((r) => r.source), ['rdns', 'geoip-city']);

  // The country centroid is NOT rejected with them, and that is the point of
  // testing a region as a region: "somewhere in DE" is feasible from Copenhagen
  // in 1 ms, because the German border is a couple of hundred km away even
  // though the centroid is 680. The hop is drawn there and marked as a guess —
  // dropping it would leave a hole in the path, which reads as a broken trace.
  assert.equal(g.place.source, 'geoip-country');
  assert.equal(g.place.certainty, 'approximate');
  assert.ok(Number.isFinite(g.lat));

  // 8 ms: Frankfurt fits as a point, and an exact candidate always wins.
  const ok = locateHop({ ip: '62.115.1.1', hostname: 'ffm-bb2-link.ip.twelve99.net', rttMs: 8 }, { geoProvider, cityProvider, centroids, origin: CPH });
  assert.equal(ok.place.city, 'Frankfurt');
  assert.equal(ok.place.certainty, 'exact');
});

test('without a useful name, city GeoIP places the hop', () => {
  const cityProvider = { lookup: () => ({ city: 'Hamburg', country: 'DE', lat: 53.5511, lng: 9.9937 }) };
  const g = locateHop({ ip: '80.1.1.1', hostname: 'edge.example.net', rttMs: 12 }, { geoProvider, cityProvider, centroids, origin: CPH });
  assert.deepEqual(g.place, { city: 'Hamburg', country: 'DE', precision: 'city', source: 'geoip-city', certainty: 'exact' });
});

test('without name or city data, the country centroid is used as before', () => {
  const g = locateHop({ ip: '80.1.1.1', rttMs: 12 }, { geoProvider, centroids, origin: CPH });
  assert.deepEqual(g.place, { city: null, country: 'DE', precision: 'country', source: 'geoip-country', certainty: 'exact' });
  assert.equal(g.lat, 51);
});

test('an anycast address registered far away is left off the map, with the reason', () => {
  const g = locateHop({ ip: '8.8.8.8', rttMs: 3 }, { geoProvider, centroids, origin: CPH });
  assert.equal(g.country, 'US');
  assert.equal(g.lat, null);
  assert.equal(g.place, null);
  assert.equal(g.rejected.length, 1);
  assert.equal(g.rejected[0].country, 'US');
  assert.ok(g.rejected[0].distanceKm > g.rejected[0].maxKm);
});

test('without the agent site nothing is rejected', () => {
  const g = locateHop({ ip: '8.8.8.8', rttMs: 3 }, { geoProvider, centroids });
  assert.equal(g.place.source, 'geoip-country');
});

test('a private hop is never looked up, even with a name', () => {
  const boom = { lookup: () => { throw new Error('must not be asked'); } };
  const g = locateHop({ ip: '10.0.0.1', hostname: 'gw.cph1.example.net', rttMs: 1 }, { geoProvider: boom, cityProvider: boom, centroids, origin: CPH });
  assert.equal(g.private, true);
  assert.equal(g.place, null);
  assert.equal(g.lat, null);
  assert.equal(g.hostname, null);
});

// ---- the city provider + builder ------------------------------------------

test('parseRow reads the built city format and refuses junk', () => {
  assert.deepEqual(parseRow('2.16.0.0,2.16.0.255,DK,55.6761,12.5683,Copenhagen'),
    { lo: 34603008, hi: 34603263, country: 'DK', lat: 55.6761, lng: 12.5683, city: 'Copenhagen' });
  assert.equal(parseRow('# header'), null);
  assert.equal(parseRow('2001:db8::,2001:db8::1,DE,50,8,Frankfurt'), null);
  assert.equal(parseRow('1.0.0.0,1.0.0.255,DK,95,12,Nowhere'), null);
  assert.equal(parseRow('1.0.0.0,1.0.0.255,Denmark,55,12,X'), null);
});

test('buildCityFromSource merges adjacent rows, skips IPv6, and the provider reads the result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-city-'));
  const src = path.join(dir, 'dbip-city.csv');
  const out = path.join(dir, 'geoip-city.csv');
  fs.writeFileSync(src, [
    '1.0.0.0,1.0.0.255,OC,AU,Queensland,"South Brisbane",-27.4748,153.017',
    '2.16.0.0,2.16.0.127,EU,DK,"Capital Region",Copenhagen,55.6761,12.5683',
    '2.16.0.128,2.16.0.255,EU,DK,"Capital Region",Copenhagen,55.6761,12.5683',
    '2.16.1.0,2.16.1.255,EU,DK,"Central Jutland","Aarhus, C",56.1629,10.2039',
    '2001:db8::,2001:db8::ffff,EU,DE,Hesse,Frankfurt,50.11,8.68',
    '',
  ].join('\n'));
  try {
    const r = await buildCityFromSource({ city: { file: src }, out });
    assert.deepEqual(r, { rows: 3, sourceRows: 4 });
    const p = createCityProvider({ dbPath: out });
    assert.equal(await p.ready, 3);
    assert.deepEqual(p.lookup('2.16.0.200'), { city: 'Copenhagen', country: 'DK', lat: 55.6761, lng: 12.5683 });
    assert.equal(p.lookup('2.16.1.9').city, 'Aarhus, C');
    assert.equal(p.lookup('3.3.3.3'), null);
    assert.equal(p.lookup('2001:db8::1'), null);
    assert.equal(p.status().configured, true);
    assert.equal(p.status().loading, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the city provider sorts an unsorted table and reports an unreadable file', async () => {
  const p = createCityProvider({ ranges: [
    { lo: 200, hi: 299, country: 'DE', lat: 50, lng: 8, city: 'B' },
    { lo: 100, hi: 199, country: 'DK', lat: 55, lng: 12, city: 'A' },
  ] });
  assert.equal(p.lookup('0.0.0.150').city, 'A');
  assert.equal(p.lookup('0.0.0.250').city, 'B');
  const bad = createCityProvider({ dbPath: '/nonexistent/geoip-city.csv' });
  assert.equal(await bad.ready, 0);
  assert.equal(bad.status().configured, false);
  assert.match(bad.status().error, /ENOENT/);
  assert.equal(bad.lookup('1.1.1.1'), null);
});

test('dbipUrls names the city file for the month', () => {
  assert.equal(dbipUrls('https://x.example/free/', '2026-09').city, 'https://x.example/free/dbip-city-lite-2026-09.csv.gz');
});

// ---- updater + settings ----------------------------------------------------

function memRepo(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { if (v === null) m.delete(k); else m.set(k, v); return v; } };
}
const quiet = { info() {}, warn() {}, error() {} };

test('the updater builds the city table from the same month and records it', async () => {
  const recorded = [];
  const settingsService = { getGeoip: async () => ({ city: { include: true } }), recordGeoipBuild: async (x) => { recorded.push(x); } };
  const cityCalls = [];
  const u = createGeoipUpdater({
    settingsService, logger: quiet, now: () => new Date('2026-09-10T00:00:00Z'),
    config: { geo: { buildPath: '/tmp/g.csv', cityBuildPath: '/tmp/gc.csv', sourceUrl: 'https://x.example/free' } },
    build: async () => ({ rows: 10 }),
    buildCity: async (opts) => { cityCalls.push(opts); return { rows: 7 }; },
  });
  const st = await u.runUpdate();
  assert.equal(st.state, 'ok');
  assert.equal(st.cityRanges, 7);
  assert.equal(cityCalls[0].city.url, 'https://x.example/free/dbip-city-lite-2026-09.csv.gz');
  assert.equal(cityCalls[0].out, '/tmp/gc.csv');
  assert.deepEqual(recorded[0].city, { dbPath: '/tmp/gc.csv', ranges: 7 });
});

test('a failing city build does not fail the update, and the toggle skips it', async () => {
  const recorded = [];
  const mk = (include, buildCity) => createGeoipUpdater({
    settingsService: { getGeoip: async () => ({ city: { include } }), recordGeoipBuild: async (x) => { recorded.push(x); } },
    logger: quiet, config: { geo: {} }, build: async () => ({ rows: 10 }), buildCity,
  });
  const st = await mk(true, async () => { throw new Error('HTTP 404'); }).runUpdate();
  assert.equal(st.state, 'ok');
  assert.equal(st.ranges, 10);
  assert.equal(st.cityError, 'HTTP 404');
  assert.equal(recorded[0].city, null);
  let asked = false;
  const off = await mk(false, async () => { asked = true; return { rows: 1 }; }).runUpdate();
  assert.equal(off.state, 'ok');
  assert.equal(asked, false);
  // The caller can override the toggle for one run.
  await mk(false, async () => { asked = true; return { rows: 1 }; }).runUpdate({ includeCity: true });
  assert.equal(asked, true);
});

test('settings: city path, include toggle and live reload', async () => {
  const reloads = [];
  const liveGeoCity = { status: () => ({ configured: true, size: 5, loading: false, error: null }), reload: async (o) => { reloads.push(o); return 5; } };
  const svc = createSettingsService({ settingsRepo: memRepo(), config: { geo: { dbPath: '', cityDbPath: '/env/city.csv' } }, liveGeoCity });
  let g = await svc.getGeoip();
  assert.deepEqual(g.city, { dbPath: '/env/city.csv', source: 'env', configured: true, ranges: 5, loading: false, error: null, include: true, lastBuild: null });
  g = await svc.setGeoip({ cityDbPath: '/data/geoip-city.csv' });
  assert.equal(g.city.dbPath, '/data/geoip-city.csv');
  assert.equal(g.city.source, 'settings');
  assert.deepEqual(reloads, [{ dbPath: '/data/geoip-city.csv' }]);
  g = await svc.setGeoip({ includeCity: false });
  assert.equal(g.city.include, false);
  assert.equal(reloads.length, 1, 'toggling include does not reload the table');
  g = await svc.setGeoip({ includeCity: true, cityDbPath: '' });
  assert.equal(g.city.include, true);
  assert.equal(g.city.source, 'env');
  await assert.rejects(svc.setGeoip({ cityDbPath: 'x'.repeat(1025) }), (e) => e.statusCode === 400);
  await svc.recordGeoipBuild({ dbPath: '/data/geoip.csv', month: '2026-09', ranges: 3, city: { dbPath: '/data/geoip-city.csv', ranges: 9 } });
  g = await svc.getGeoip();
  assert.equal(g.city.lastBuild.ranges, 9);
  assert.equal(g.city.lastBuild.month, '2026-09');
});

// ---- the path graph + live hops --------------------------------------------

const run = (ts, hops) => ({ type: 'traceroute', target: 'example.com', ts, ok: true, hops });

test('buildPathGraph places hops by router name and carries the hostname', () => {
  const runs = [
    run('2026-09-01T10:00:00Z', [
      { hop: 1, ip: '192.168.1.1', rttMs: 0.5, minMs: 0.4 },
      { hop: 2, ip: '62.115.1.1', rttMs: 2, minMs: 1.5, hostname: 'kbn-bb6-link.ip.twelve99.net' },
      { hop: 3, ip: '80.1.1.1', rttMs: 14, minMs: 12 },
      { hop: 4, ip: '8.8.8.8', rttMs: 3.1, minMs: 3 },
    ]),
  ];
  const g = buildPathGraph(runs, { geoProvider, centroids, origin: { lat: CPH.lat, lng: CPH.lng, label: 'Agent' } });
  const [, h1, h2, h3, h4] = g.nodes;
  assert.equal(h1.place, null);
  assert.equal(h2.place.city, 'Copenhagen');
  assert.equal(h2.hostname, 'kbn-bb6-link.ip.twelve99.net');
  assert.equal(h3.place.precision, 'country');
  assert.equal(h4.lat, null, 'anycast 8.8.8.8 at 3 ms is not drawn in the US');
  assert.equal(h4.geoRejected[0].country, 'US');
  // The ECMP branches get the same placement.
  const b2 = g.branches.hops.find((h) => h.hop === 2).ips[0];
  assert.equal(b2.place.city, 'Copenhagen');
});

test('buildPathGraph uses the fastest reply across runs for the check', () => {
  const runs = [
    run('2026-09-01T10:00:00Z', [{ hop: 1, ip: '8.8.8.8', rttMs: 200, minMs: 190 }]),
    run('2026-09-01T11:00:00Z', [{ hop: 1, ip: '8.8.8.8', rttMs: 4, minMs: 3 }]),
  ];
  const g = buildPathGraph(runs, { geoProvider, centroids, origin: CPH });
  assert.equal(g.nodes[1].lat, null, 'one fast reply is enough to rule the US out');
});

test('live hops get the same placement, and the async describe keeps the frame', async () => {
  const n = describeLiveHop({ hop: 2, ip: '62.115.1.1', rttMs: 2, minMs: 1.5, hostname: 'AE3.CPH-BB1.telia.net' }, { geoProvider, centroids, origin: CPH });
  assert.equal(n.place.city, 'Copenhagen');
  assert.equal(n.hostname, 'ae3.cph-bb1.telia.net');
  const bad = describeLiveHop({ hop: 2, ip: '62.115.1.1', rttMs: 2, hostname: '<img src=x>' }, { geoProvider, centroids });
  assert.equal(bad.hostname, null);

  const p = traceHopPayload(9, { type: 'trace_hop', probeType: 'traceroute', target: 'x.example', hop: { hop: 2, ip: '62.115.1.1', rttMs: 2 } },
    async (hop, agentId) => ({ ...describeLiveHop(hop, { geoProvider, centroids }), agentSeen: agentId }));
  assert.equal(typeof p.then, 'function');
  const payload = await p;
  assert.equal(payload.agentId, 9);
  assert.equal(payload.node.agentSeen, 9);
  assert.equal(payload.node.place.source, 'geoip-country');
  const failed = await traceHopPayload(9, { type: 'trace_hop', probeType: 'traceroute', target: 'x', hop: { hop: 1 } }, async () => { throw new Error('db down'); });
  assert.equal(failed, null);
});

// ---- ingest ----------------------------------------------------------------

test('hop hostnames are stored cleaned, and anything else is dropped', () => {
  const { value, errors } = validateProbeResults({ results: [{
    type: 'traceroute', target: 'example.com', ok: true,
    hops: [
      { hop: 1, ip: '62.115.1.1', rttMs: 2, hostname: 'KBN-BB6-Link.ip.twelve99.net.' },
      { hop: 2, ip: '80.1.1.1', rttMs: 9, hostname: '<script>alert(1)</script>' },
      { hop: 3, ip: '80.1.1.2', rttMs: 9 },
    ],
  }] });
  assert.equal(errors, undefined);
  const hops = value.results ? value.results[0].hops : value[0].hops;
  assert.equal(hops[0].hostname, 'kbn-bb6-link.ip.twelve99.net');
  assert.equal(hops[1].hostname, null);
  assert.equal(hops[2].hostname, null);
});

// ---- API -------------------------------------------------------------------

const tracerouteRows = [run('2026-09-01T10:00:00Z', [
  { hop: 1, ip: '192.168.1.1', rttMs: 0.5 },
  { hop: 2, ip: '62.115.1.1', rttMs: 2, minMs: 1.5, hostname: 'ae3.cph-bb1.telia.net' },
  { hop: 3, ip: '8.8.8.8', rttMs: 3, minMs: 3 },
])];
const agentAtCph = makeAgentsRepo({ findById: async (id) => (id === 9 ? { id, hostname: 'h1', location_lat: CPH.lat, location_lng: CPH.lng } : null) });

test('GET /api/probes/path returns the placement per hop (200)', async () => {
  const cityProvider = { lookup: () => null };
  const res = await request(makeApp({
    agentsRepo: agentAtCph, probeResultsRepo: makeProbeResultsRepo({ findByAgent: async () => tracerouteRows }),
    geoProvider, cityProvider, centroids,
  })).get('/api/probes/path?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const [, h1, h2, h3] = res.body.nodes;
  assert.equal(h1.private, true);
  assert.deepEqual(h2.place, { city: 'Copenhagen', country: 'DK', precision: 'city', source: 'rdns', code: 'cph', certainty: 'exact' });
  assert.equal(h2.hostname, 'ae3.cph-bb1.telia.net');
  assert.equal(h3.lat, null);
  assert.equal(h3.geoRejected[0].source, 'geoip-country');
});

test('GET /api/probes/path is 404 for an unknown agent', async () => {
  const res = await request(makeApp({ agentsRepo: agentAtCph, geoProvider, centroids }))
    .get('/api/probes/path?agentId=10').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /api/probes/path is 500 when the probe store fails', async () => {
  const res = await request(makeApp({
    agentsRepo: agentAtCph,
    probeResultsRepo: makeProbeResultsRepo({ findByAgent: throwingAsync('db exploded: secret detail') }),
    geoProvider, centroids,
  })).get('/api/probes/path?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!res.text.includes('    at '), 'no stack trace in the body');
});

test('GET /api/nope-city is 404', async () => {
  const res = await request(makeApp()).get('/api/nope-city').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});
