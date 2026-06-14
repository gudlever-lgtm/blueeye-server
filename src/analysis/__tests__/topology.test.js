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

test('caps nodes/edges by weight and flags truncation', () => {
  const rows = [];
  for (let i = 0; i < 50; i += 1) rows.push({ srcIp: '10.0.0.1', dstIp: `10.0.1.${i}`, bytes: i + 1 });
  const g = buildTopology(rows, { maxNodes: 10, maxEdges: 5 });
  assert.equal(g.nodes.length, 10);
  assert.equal(g.edges.length, 5);
  assert.equal(g.truncated, true);
  assert.equal(g.totals.edges, 50); // totals reflect the full graph
});
