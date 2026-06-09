'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPathGraph } = require('../pathGraph');

// A tiny fake GeoIP provider + centroids, EU-style (no real DB needed).
const geoProvider = { lookup: (ip) => (ip === '93.184.216.34' ? { country: 'DE', asn: 64500, asnName: 'Example Telco' } : null) };
const centroids = { get: (c) => (c === 'DE' ? { lat: 51, lng: 10 } : null) };

const run = (ts, hops, target = 'example.com') => ({ type: 'traceroute', target, ts, hops });

test('buildPathGraph returns an empty graph for no traceroutes', () => {
  const g = buildPathGraph([], { target: 'x' });
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.links, []);
  assert.equal(g.samples, 0);
});

test('buildPathGraph builds source → hops → dest with links between them', () => {
  const g = buildPathGraph([
    run('2026-06-09T10:00:00Z', [
      { hop: 1, ip: '10.0.0.1', sent: 3, recv: 3, lossPct: 0, rttMs: 1, jitterMs: 0.2 },
      { hop: 2, ip: '93.184.216.34', sent: 3, recv: 3, lossPct: 0, rttMs: 12, jitterMs: 1 },
    ]),
  ], { geoProvider, centroids });
  // source + 2 hops
  assert.equal(g.nodes.length, 3);
  assert.equal(g.nodes[0].kind, 'source');
  assert.equal(g.nodes[1].kind, 'hop');
  assert.equal(g.nodes[2].kind, 'dest');
  // a link per consecutive pair
  assert.equal(g.links.length, 2);
  assert.deepEqual(g.links.map((l) => [l.from, l.to]), [[0, 1], [1, 2]]);
  // incremental latency on the dest link: 12 - 1 = 11 ms
  assert.equal(g.links[1].latencyMs, 11);
});

test('buildPathGraph enriches public hop IPs with GeoIP/ASN and skips private', () => {
  const g = buildPathGraph([
    run('2026-06-09T10:00:00Z', [
      { hop: 1, ip: '10.0.0.1', sent: 3, recv: 3, lossPct: 0, rttMs: 1 },
      { hop: 2, ip: '93.184.216.34', sent: 3, recv: 3, lossPct: 0, rttMs: 12 },
    ]),
  ], { geoProvider, centroids });
  const priv = g.nodes.find((n) => n.ip === '10.0.0.1');
  const pub = g.nodes.find((n) => n.ip === '93.184.216.34');
  assert.equal(priv.private, true);
  assert.equal(priv.asn, null); // never geolocated
  assert.equal(pub.country, 'DE');
  assert.equal(pub.asn, 64500);
  assert.equal(pub.lat, 51);
});

test('buildPathGraph aggregates repeated runs with the median and flags loss', () => {
  const hopsOf = (loss, rtt) => [
    { hop: 1, ip: '10.0.0.1', sent: 4, recv: 4, lossPct: 0, rttMs: 1 },
    { hop: 2, ip: '203.0.113.9', sent: 4, recv: Math.round(4 * (1 - loss / 100)), lossPct: loss, rttMs: rtt, jitterMs: 2 },
  ];
  const g = buildPathGraph([
    run('2026-06-09T10:00:00Z', hopsOf(0, 10)),
    run('2026-06-09T10:01:00Z', hopsOf(50, 12)),
    run('2026-06-09T10:02:00Z', hopsOf(50, 11)),
  ], {});
  const dest = g.nodes[g.nodes.length - 1];
  assert.equal(g.samples, 3);
  assert.equal(dest.lossPct, 50); // median of [0,50,50]
  assert.equal(dest.worstLossPct, 50);
  assert.equal(dest.severity, 'bad'); // 50% >= bad threshold (20)
  assert.match(dest.explain, /loss/);
});

test('buildPathGraph treats a never-responding hop as a muted silent router, not a fault', () => {
  const g = buildPathGraph([
    run('2026-06-09T10:00:00Z', [
      { hop: 1, ip: '10.0.0.1', sent: 3, recv: 3, lossPct: 0, rttMs: 1 },
      { hop: 2, ip: null, sent: 3, recv: 0, lossPct: 100, rttMs: null },
      { hop: 3, ip: '93.184.216.34', sent: 3, recv: 3, lossPct: 0, rttMs: 12 },
    ]),
  ], { geoProvider, centroids });
  const silent = g.nodes.find((n) => n.hop === 2);
  assert.equal(silent.unresponsive, true);
  assert.equal(silent.severity, 'muted');
  assert.match(silent.explain, /silent/i);
});

test('buildPathGraph derives loss from legacy single-sample hops (rttMs only)', () => {
  // Old agents send { hop, ip, rttMs } with no lossPct — answered ⇒ 0%, timeout ⇒ 100%.
  const g = buildPathGraph([
    run('2026-06-09T10:00:00Z', [
      { hop: 1, ip: '10.0.0.1', rttMs: 1 },
      { hop: 2, ip: null, rttMs: null },
    ]),
  ], {});
  assert.equal(g.nodes[1].lossPct, 0);
  assert.equal(g.nodes[2].lossPct, 100);
  assert.equal(g.nodes[2].unresponsive, true);
});
