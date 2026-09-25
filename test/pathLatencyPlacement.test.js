'use strict';

// Placing hops by the path itself, and noticing when the agent is not where
// its site says. The case that prompted it: a "localhost" agent whose site is
// Copenhagen, tracing us.cnn.com, first hop a DigitalOcean router at 4 ms
// (block registered in CZ), then three more DigitalOcean routers at 2-3 ms
// (registered in CA). The map drew a line from Copenhagen to the middle of the
// Czech Republic. Four replies inside 4 ms are one building.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { settlePath, NEAR_MS, LOCAL_MS } = require('../src/geo/hopLocation');
const { cloudOrigin, providerOf } = require('../src/geo/hostingNetworks');
const { buildPathGraph, describeLiveHop, createLiveTraces } = require('../src/analysis/pathGraph');
const { createCentroids } = require('../src/geo/centroids');
const { makeApp, makeAgentsRepo, makeProbeResultsRepo, authHeader } = require('../test-support/fakes');

const CPH = { lat: 55.6761, lng: 12.5683 };
const centroids = createCentroids();
const DO = { asn: 14061, asnName: 'DigitalOcean, LLC' };
const geoProvider = {
  lookup: (ip) => {
    if (ip === '5.101.110.7') return { country: 'CZ', ...DO };
    if (ip.startsWith('143.244.')) return { country: 'CA', ...DO };
    if (ip === '80.1.1.1') return { country: 'DE', asn: 3320, asnName: 'DTAG' };
    if (ip === '62.115.1.1') return { country: 'SE', asn: 1299, asnName: 'ARELION' };
    return null;
  },
};

const SCREENSHOT = [
  { hop: 1, ip: '5.101.110.7', rttMs: 4 },
  { hop: 2, ip: '143.244.192.32', rttMs: 3 },
  { hop: 3, ip: '143.244.224.82', rttMs: 2 },
  { hop: 4, ip: '143.244.224.81', rttMs: 2 },
  { hop: 5, ip: null, rttMs: null },
  { hop: 6, ip: null, rttMs: null },
];
const run = (hops) => ({ type: 'traceroute', target: 'us.cnn.com', ts: '2026-09-25T10:00:00Z', ok: true, hops });

// ---- the reported case -----------------------------------------------------

test('the reported trace: every hop is drawn where its address is registered, and says how sure', () => {
  const g = buildPathGraph([run(SCREENSHOT)], { geoProvider, centroids, origin: { ...CPH, label: 'Localhost agent test' } });
  const hops = g.nodes.filter((n) => n.kind !== 'source' && n.ip);
  assert.equal(hops.length, 4);
  // Every hop that GeoIP can place IS on the map. Collapsing them onto the
  // agent — which is what the reply times alone would say — threw away the
  // only thing known about each address.
  for (const n of hops) assert.ok(Number.isFinite(n.lat), `hop ${n.hop} is on the map`);
  assert.equal(hops[0].place.country, 'CZ');
  assert.equal(hops[1].place.country, 'CA');
  // ...and every one is labelled. The Czech border IS within 4 ms of
  // Copenhagen even though the centroid is not, so that marker stands for the
  // country. Canada in 3 ms is not a place at all — that is a registration.
  assert.equal(hops[0].place.certainty, 'approximate');
  for (const n of hops.slice(1)) assert.equal(n.place.certainty, 'registration', `hop ${n.hop}`);
  for (const n of hops) assert.ok(n.withinKm > 0, 'what the reply time proves on its own');
});

test('the reported trace says the agent looks to run at DigitalOcean', () => {
  const g = buildPathGraph([run(SCREENSHOT)], { geoProvider, centroids, origin: CPH });
  assert.deepEqual(g.originHint, { hop: 1, ip: '5.101.110.7', asn: 14061, provider: 'DigitalOcean', rttMs: 4 });
});

test('the same trace streamed live is placed the same way, hop by hop', () => {
  const live = createLiveTraces();
  const out = SCREENSHOT.map((h) => live.settle('9|traceroute|us.cnn.com',
    describeLiveHop(h, { geoProvider, centroids, origin: CPH }), CPH));
  assert.deepEqual(out.slice(0, 4).map((n) => n.place.country), ['CZ', 'CA', 'CA', 'CA']);
  assert.deepEqual(out.slice(0, 4).map((n) => n.place.certainty), ['approximate', 'registration', 'registration', 'registration']);
  assert.equal(out[0].originHint.provider, 'DigitalOcean', 'the hint rides on the hop that gives it away');
  assert.equal(out[1].originHint, undefined);
  assert.equal(out[4].lat, null, 'a silent hop stays unplaced');
});

// ---- settlePath ------------------------------------------------------------

const node = (hop, ip, extra = {}) => ({ hop, ip, private: false, lat: null, lng: null, place: null, withinKm: 300, ...extra });

test('settlePath fills a hop GeoIP could not place at all, and never moves one it could', () => {
  const fra = node(3, '1.1.1.3', { lat: 50.11, lng: 8.68, place: { city: 'Frankfurt', country: 'DE', precision: 'city', source: 'rdns', certainty: 'exact' } });
  // This one HAS an answer of its own (a country centroid). It keeps it: its
  // address says something, and overriding that with "near the last hop"
  // collapsed whole paths onto one dot.
  const own = node(4, '1.1.1.4', { lat: 51, lng: 10, place: { city: null, country: 'DE', precision: 'country', source: 'geoip-country', certainty: 'exact' } });
  const unplaced = node(5, '1.1.1.5');
  settlePath([{ hop: 3, rttMs: 12, node: fra }, { hop: 4, rttMs: 13.2, node: own }, { hop: 5, rttMs: 13.9, node: unplaced }], { origin: CPH });
  assert.equal(own.place.source, 'geoip-country', 'its own placement survived');
  assert.equal(own.lat, 51);
  // The one with nothing at all is drawn with its neighbour rather than left
  // as a hole in the path.
  assert.equal(unplaced.place.source, 'latency');
  assert.equal(unplaced.place.nearHop, 4, 'the nearest placed hop before it');
  assert.equal(unplaced.lat, 51);
  assert.equal(unplaced.withinKm, null, 'placed, so the radius note no longer applies');
});

test('an unplaced hop further behind than NEAR_MS is left unplaced', () => {
  const fra = node(3, '1.1.1.3', { lat: 50.11, lng: 8.68, place: { city: 'Frankfurt', country: 'DE', precision: 'city', source: 'rdns', certainty: 'exact' } });
  const far = node(4, '1.1.1.4');
  settlePath([{ hop: 3, rttMs: 12, node: fra }, { hop: 4, rttMs: 12 + NEAR_MS + 80, node: far }], { origin: CPH });
  assert.equal(far.place, null, '80 ms later is not the same building');
  assert.equal(far.lat, null);
});

test('a placed hop becomes the anchor for the unplaced ones behind it', () => {
  const a = node(2, '1.1.1.2', { lat: 55.68, lng: 12.57, place: { city: 'Copenhagen', country: 'DK', precision: 'city', source: 'rdns', certainty: 'exact' } });
  const b = node(3, '1.1.1.3', { lat: 53.55, lng: 9.99, place: { city: 'Hamburg', country: 'DE', precision: 'city', source: 'geoip-city', certainty: 'exact' } });
  const c = node(4, '1.1.1.4');
  settlePath([{ hop: 2, rttMs: 1, node: a }, { hop: 3, rttMs: 1.5, node: b }, { hop: 4, rttMs: 2, node: c }], { origin: CPH });
  assert.equal(b.place.city, 'Hamburg', 'its own city wins, even close behind another');
  assert.equal(b.place.source, 'geoip-city');
  assert.equal(c.place.nearHop, 3, 'and the next weak hop follows it');
});

test('a filled-in hop is never an anchor, so small steps cannot creep across a map', () => {
  const a = node(1, '1.1.1.1', { lat: 50.11, lng: 8.68, place: { city: 'Frankfurt', country: 'DE', precision: 'city', source: 'rdns', certainty: 'exact' } });
  const steps = [2, 3, 4].map((h) => node(h, `1.1.1.${h}`));
  settlePath([{ hop: 1, rttMs: 20, node: a }, { hop: 2, rttMs: 21.9, node: steps[0] }, { hop: 3, rttMs: 23.8, node: steps[1] }, { hop: 4, rttMs: 40, node: steps[2] }], { origin: CPH });
  assert.equal(steps[0].place.nearHop, 1, '1.9 ms behind a real placement: filled in');
  assert.equal(steps[1].place, null, '3.8 ms behind the only real anchor: not placed');
  assert.equal(steps[2].place, null);
});

test('hops within LOCAL_MS of the agent are drawn at its site; further ones are not', () => {
  const near = node(1, '1.1.1.1');
  const far = node(2, '1.1.1.2');
  settlePath([{ hop: 1, rttMs: LOCAL_MS, node: near }, { hop: 2, rttMs: LOCAL_MS + 0.5, node: far }], { origin: CPH });
  assert.equal(near.place.nearHop, 0);
  assert.equal(near.place.precision, 'site');
  assert.equal(far.place, null);
});

test('private and silent hops are left alone; without an origin only hop anchors count', () => {
  const lan = node(1, '192.168.1.1', { private: true });
  const silent = node(2, null);
  const lone = node(3, '1.1.1.3');
  settlePath([{ hop: 1, rttMs: 0.4, node: lan }, { hop: 2, rttMs: null, node: silent }, { hop: 3, rttMs: 1, node: lone }], { origin: null });
  assert.equal(lan.place, null);
  assert.equal(silent.place, null);
  assert.equal(lone.place, null, 'no agent site and no anchor before it: nothing to place it by');
});

// ---- cloud origin ----------------------------------------------------------

test('providerOf matches by ASN, then by AS name', () => {
  assert.equal(providerOf(14061, null), 'DigitalOcean');
  assert.equal(providerOf(null, 'Hetzner Online GmbH'), 'Hetzner');
  assert.equal(providerOf(16509, 'whatever'), 'Amazon Web Services');
  assert.equal(providerOf(3320, 'Deutsche Telekom AG'), null);
  assert.equal(providerOf(null, null), null);
});

test('cloudOrigin looks only at the first public hop, and only when it is close', () => {
  const src = { kind: 'source', hop: 0 };
  const lan = { hop: 1, ip: '10.0.0.1', private: true, rttMs: 0.3 };
  const doHop = { hop: 2, ip: '5.101.110.7', asn: 14061, asnName: 'DigitalOcean, LLC', rttMs: 1.2 };
  assert.equal(cloudOrigin([src, lan, doHop]).provider, 'DigitalOcean', 'a VPC gateway before it does not hide it');
  assert.equal(cloudOrigin([src, { ...doHop, rttMs: 30 }]), null, 'far away: a cloud on the path, not under the agent');
  const isp = { hop: 2, ip: '80.1.1.1', asn: 3320, asnName: 'DTAG', rttMs: 8 };
  assert.equal(cloudOrigin([src, lan, isp, { ...doHop, hop: 3 }]), null, 'the first public hop is the ISP: the agent is not in a cloud');
  assert.equal(cloudOrigin([src, { hop: 1, ip: null, rttMs: null }, doHop]).hop, 2, 'a silent hop is skipped');
  assert.equal(cloudOrigin([]), null);
});

test('an agent on a normal ISP line gets no hint', () => {
  const g = buildPathGraph([run([
    { hop: 1, ip: '192.168.1.1', rttMs: 0.5 },
    { hop: 2, ip: '80.1.1.1', rttMs: 9 },
  ])], { geoProvider, centroids, origin: CPH });
  assert.equal(g.originHint, null);
});

// ---- live trace state ------------------------------------------------------

test('live traces restart on hop 1, expire, and stay bounded', () => {
  let clock = 0;
  const live = createLiveTraces({ ttlMs: 1000, maxTraces: 2, now: () => clock });
  const d = (hop, ip, rttMs) => describeLiveHop({ hop, ip, rttMs }, { geoProvider, centroids, origin: CPH });
  live.settle('a', d(1, '5.101.110.7', 4), CPH);
  live.settle('b', d(1, '5.101.110.7', 4), CPH);
  live.settle('c', d(1, '5.101.110.7', 4), CPH);
  assert.equal(live.size, 2, 'the oldest trace is dropped');
  clock = 5000;
  const late = live.settle('c', d(2, '80.1.1.1', 30), CPH);
  assert.equal(late.place.source, 'geoip-country');
  assert.equal(live.settle('c', null, CPH), null);
});

// ---- API -------------------------------------------------------------------

const agentRepo = makeAgentsRepo({ findById: async (id) => (id === 9 ? { id, hostname: 'localhost', location_lat: CPH.lat, location_lng: CPH.lng } : null) });

test('GET /api/probes/path carries originHint and the latency placement (200)', async () => {
  const res = await request(makeApp({
    agentsRepo: agentRepo, probeResultsRepo: makeProbeResultsRepo({ findByAgent: async () => [run(SCREENSHOT)] }),
    geoProvider, centroids,
  })).get('/api/probes/path?agentId=9&target=us.cnn.com').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.originHint.provider, 'DigitalOcean');
  assert.equal(res.body.nodes[1].place.country, 'CZ', 'drawn where the address is registered');
  assert.equal(res.body.nodes[1].place.certainty, 'approximate');
});

test('GET /api/probes/path is 404 for an unknown agent and 400 without one', async () => {
  const app = makeApp({ agentsRepo: agentRepo, geoProvider, centroids });
  assert.equal((await request(app).get('/api/probes/path?agentId=10').set('Authorization', authHeader('viewer'))).status, 404);
  assert.equal((await request(app).get('/api/probes/path').set('Authorization', authHeader('viewer'))).status, 400);
});

test('GET /api/probes/path is 500 when the agent store fails', async () => {
  const res = await request(makeApp({
    agentsRepo: makeAgentsRepo({ findById: async () => { throw new Error('db down'); } }), geoProvider, centroids,
  })).get('/api/probes/path?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});
