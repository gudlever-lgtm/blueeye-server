'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractAsPath, diffAsPath, asGraphFromNodes } = require('../src/analysis/asPath');

// A tiny fake GeoIP/ASN provider backed by a lookup map.
const geoFrom = (map) => ({ lookup: (ip) => map[ip] || null });

test('extractAsPath collapses consecutive same-AS hops and skips private hops', () => {
  const geo = geoFrom({
    '203.0.113.1': { asn: 100, asnName: 'A', country: 'DE' },
    '203.0.113.2': { asn: 100, asnName: 'A', country: 'DE' },
    '198.51.100.1': { asn: 200, asnName: 'B', country: 'NL' },
  });
  const hops = [
    { hop: 1, ip: '10.0.0.1' },      // private → skipped
    { hop: 2, ip: '203.0.113.1' },   // AS100
    { hop: 3, ip: '203.0.113.2' },   // AS100 (collapse)
    { hop: 4, ip: '198.51.100.1' },  // AS200
  ];
  const p = extractAsPath(hops, { geoProvider: geo });
  assert.deepEqual(p.sequence, [100, 200]);
  assert.equal(p.origin, 200);
  assert.equal(p.length, 2);
  assert.deepEqual(p.segments[0].hops, [2, 3]);
  assert.equal(p.segments[1].asnName, 'B');
});

test('extractAsPath counts public hops it cannot map to an AS as gaps', () => {
  const geo = geoFrom({ '203.0.113.1': { asn: 100 } });
  const p = extractAsPath([{ hop: 1, ip: '203.0.113.1' }, { hop: 2, ip: '198.51.100.7' }], { geoProvider: geo });
  assert.deepEqual(p.sequence, [100]);
  assert.equal(p.gaps, 1);
});

test('extractAsPath without a provider yields an empty path', () => {
  const p = extractAsPath([{ hop: 1, ip: '203.0.113.1' }]);
  assert.deepEqual(p.sequence, []);
  assert.equal(p.origin, null);
});

test('diffAsPath flags an origin change with the additions and removals', () => {
  const d = diffAsPath([100, 200], [100, 300]);
  assert.equal(d.changed, true);
  assert.equal(d.originChanged, true);
  assert.deepEqual(d.added, [300]);
  assert.deepEqual(d.removed, [200]);
  assert.equal(d.prevOrigin, 200);
  assert.equal(d.curOrigin, 300);
});

test('diffAsPath flags a mid-path reroute that keeps the same origin', () => {
  const d = diffAsPath([100, 200, 999], [100, 300, 999]);
  assert.equal(d.changed, true);
  assert.equal(d.originChanged, false);
  assert.deepEqual(d.added, [300]);
  assert.deepEqual(d.removed, [200]);
});

test('diffAsPath reports no change for an identical sequence', () => {
  const d = diffAsPath([1, 2, 3], [1, 2, 3]);
  assert.equal(d.changed, false);
  assert.equal(d.originChanged, false);
  assert.deepEqual(d.added, []);
  assert.equal(d.lengthDelta, 0);
});

test('asGraphFromNodes collapses path-graph nodes by ASN, source first, dest last', () => {
  const nodes = [
    { index: 0, kind: 'source', asn: null, label: 'Agent', severity: 'ok', rttMs: 0, lossPct: 0 },
    { index: 1, kind: 'hop', hop: 1, asn: null, private: true, severity: 'ok' }, // private → dropped
    { index: 2, kind: 'hop', hop: 2, asn: 100, asnName: 'A', country: 'DE', rttMs: 5, lossPct: 0, severity: 'ok' },
    { index: 3, kind: 'hop', hop: 3, asn: 100, asnName: 'A', country: 'DE', rttMs: 7, lossPct: 1, severity: 'warn' },
    { index: 4, kind: 'dest', hop: 4, asn: 200, asnName: 'B', country: 'NL', rttMs: 20, lossPct: 0, severity: 'ok' },
  ];
  const g = asGraphFromNodes(nodes);
  assert.equal(g.nodes.length, 3); // source, AS100, AS200
  assert.equal(g.nodes[0].kind, 'source');
  assert.equal(g.nodes[1].asn, 100);
  assert.deepEqual(g.nodes[1].hops, [2, 3]);
  assert.equal(g.nodes[1].severity, 'warn'); // worst of the members
  assert.equal(g.nodes[1].rttMs, 7); // last member's cumulative RTT
  assert.equal(g.nodes[1].lossPct, 1); // worst member loss
  assert.equal(g.nodes[2].kind, 'dest');
  assert.equal(g.nodes[2].asn, 200);
  assert.equal(g.links.length, 2);
  assert.deepEqual(g.links[1], { from: 1, to: 2, severity: 'ok' });
});

test('asGraphFromNodes returns just the source when no hop has an ASN', () => {
  const g = asGraphFromNodes([
    { index: 0, kind: 'source', asn: null, label: 'Agent', severity: 'ok' },
    { index: 1, kind: 'dest', hop: 1, asn: null, private: true, severity: 'ok' },
  ]);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.nodes[0].kind, 'source');
  assert.equal(g.links.length, 0);
});
