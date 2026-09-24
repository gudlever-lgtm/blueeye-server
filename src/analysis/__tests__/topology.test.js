'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildTopology } = require('../topology');

test('classifies internal vs external endpoints and carries peer ASN/country', () => {
  const g = buildTopology([
    { srcIp: '10.0.0.5', dstIp: '8.8.8.8', extIp: '8.8.8.8', asn: 15169, asnName: 'GOOGLE', country: 'US', bytes: 1000, packets: 10, flowCount: 2 },
    { srcIp: '10.0.0.5', dstIp: '10.0.0.6', extIp: null, bytes: 500, packets: 5, flowCount: 1 }, // internal↔internal
  ]);
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.equal(byId['10.0.0.5'].kind, 'internal');
  assert.equal(byId['10.0.0.6'].kind, 'internal');
  assert.equal(byId['8.8.8.8'].kind, 'external');
  assert.equal(byId['8.8.8.8'].asnName, 'GOOGLE'); // peer metadata attached to the external node only
  assert.equal(byId['8.8.8.8'].country, 'US');
  assert.equal(byId['10.0.0.5'].country, null); // internal nodes never carry geo
  assert.equal(g.totals.internal, 2);
  assert.equal(g.totals.external, 1);
});

test('aggregates repeated conversations into one weighted edge', () => {
  const g = buildTopology([
    { srcIp: '10.0.0.5', dstIp: '10.0.0.6', bytes: 100, packets: 1, flowCount: 1 },
    { srcIp: '10.0.0.5', dstIp: '10.0.0.6', bytes: 200, packets: 2, flowCount: 3 },
  ]);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].bytes, 300);
  assert.equal(g.edges[0].flows, 4);
  // src accrues bytesOut, dst accrues bytesIn.
  const src = g.nodes.find((n) => n.id === '10.0.0.5');
  const dst = g.nodes.find((n) => n.id === '10.0.0.6');
  assert.equal(src.bytesOut, 300);
  assert.equal(dst.bytesIn, 300);
  assert.equal(src.degree, 1);
});

test('ignores self-loops and incomplete rows', () => {
  const g = buildTopology([
    { srcIp: '10.0.0.5', dstIp: '10.0.0.5', bytes: 100 }, // self-loop
    { srcIp: '10.0.0.5', dstIp: null, bytes: 100 }, // missing peer
    { srcIp: '10.0.0.5', dstIp: '10.0.0.6', bytes: 100 },
  ]);
  assert.equal(g.edges.length, 1);
  assert.equal(g.nodes.length, 2);
});

test('attaches country centroids to external nodes when a centroids lookup is injected', () => {
  const centroids = { get: (c) => (c === 'US' ? { lat: 38, lng: -97 } : null) };
  const g = buildTopology([
    { srcIp: '10.0.0.5', dstIp: '8.8.8.8', extIp: '8.8.8.8', asn: 15169, asnName: 'GOOGLE', country: 'US', bytes: 1000 },
  ], { centroids });
  const ext = g.nodes.find((n) => n.id === '8.8.8.8');
  const int = g.nodes.find((n) => n.id === '10.0.0.5');
  assert.equal(ext.lat, 38);
  assert.equal(ext.lng, -97);
  assert.equal(int.lat, null); // internal hosts are never geolocated
  assert.equal(int.lng, null);
});

test('external node with an unknown country keeps null coordinates', () => {
  const g = buildTopology([
    { srcIp: '10.0.0.5', dstIp: '1.1.1.1', extIp: '1.1.1.1', country: 'ZZ', bytes: 10 },
  ], { centroids: { get: () => null } });
  const ext = g.nodes.find((n) => n.id === '1.1.1.1');
  assert.equal(ext.lat, null);
  assert.equal(ext.lng, null);
  assert.equal(ext.country, 'ZZ');
});

test('nodes carry null coordinates when no centroids lookup is provided', () => {
  const g = buildTopology([
    { srcIp: '10.0.0.5', dstIp: '8.8.8.8', extIp: '8.8.8.8', country: 'US', bytes: 10 },
  ]);
  const ext = g.nodes.find((n) => n.id === '8.8.8.8');
  assert.equal(ext.lat, null);
  assert.equal(ext.lng, null);
});

test('caps nodes/edges by weight and flags truncation', () => {
  const rows = [];
  for (let i = 0; i < 50; i += 1) rows.push({ srcIp: '10.0.0.1', dstIp: `10.0.1.${i}`, bytes: i + 1 });
  const g = buildTopology(rows, { maxNodes: 10, maxEdges: 5 });
  assert.equal(g.nodes.length, 10);
  assert.equal(g.edges.length, 5);
  assert.equal(g.truncated, true);
  assert.equal(g.totals.edges, 50); // totals reflect the full graph
});

test('an edge says what it carries: named services, dominant first, OT flagged', () => {
  const g = buildTopology([
    {
      srcIp: '10.1.1.9', dstIp: '10.1.1.5', bytes: 5000, packets: 50, flowCount: 5,
      services: [{ port: 502, proto: 'tcp', bytes: 4000 }, { port: 443, proto: 'tcp', bytes: 1000 }],
    },
    { srcIp: '10.0.0.5', dstIp: '10.0.0.6', bytes: 100, packets: 1, flowCount: 1, services: [{ port: 443, proto: 'tcp', bytes: 100 }] },
  ]);
  const scada = g.edges.find((e) => e.from === '10.1.1.9');
  assert.equal(scada.service, 'Modbus/TCP');
  assert.equal(scada.ot, true);
  assert.deepEqual(scada.services.map((s) => [s.port, s.name, s.category]), [[502, 'Modbus/TCP', 'ot'], [443, 'HTTPS', 'web']]);
  const office = g.edges.find((e) => e.from === '10.0.0.5');
  assert.equal(office.service, 'HTTPS');
  assert.equal(office.ot, false);
});

test('an unnamed service port is shown as port/proto, and an edge without ports has none', () => {
  const g = buildTopology([
    { srcIp: '10.0.0.5', dstIp: '10.0.0.6', bytes: 10, services: [{ port: 3000, proto: 'tcp', bytes: 10 }] },
    { srcIp: '10.0.0.7', dstIp: '10.0.0.8', bytes: 5 }, // older repo / fake: no services at all
  ]);
  assert.equal(g.edges.find((e) => e.from === '10.0.0.5').service, '3000/tcp');
  const bare = g.edges.find((e) => e.from === '10.0.0.7');
  assert.deepEqual(bare.services, []);
  assert.equal(bare.service, null);
  assert.equal(bare.ot, false);
});

test('one pair arriving as several rows keeps ONE service list, not a doubled one', () => {
  const services = [{ port: 102, proto: 'tcp', bytes: 50 }];
  const g = buildTopology([
    { srcIp: '10.0.0.5', dstIp: '10.0.0.6', extIp: null, bytes: 30, services },
    { srcIp: '10.0.0.5', dstIp: '10.0.0.6', extIp: '10.0.0.6', bytes: 20, services },
  ]);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].services.length, 1);
  assert.equal(g.edges[0].ot, true);
});

test('an admin-edited category list decides what counts as OT', () => {
  const rows = [{ srcIp: '10.0.0.5', dstIp: '10.0.0.6', bytes: 10, services: [{ port: 9999, proto: 'tcp', bytes: 10 }] }];
  assert.equal(buildTopology(rows).edges[0].ot, false);
  const categories = [{ id: 'ot', label: 'Plant', kind: 'port', ports: [9999] }];
  assert.equal(buildTopology(rows, { categories }).edges[0].ot, true);
});
