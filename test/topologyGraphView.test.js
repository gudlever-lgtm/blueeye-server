'use strict';

// Unit tests for the pure topology-map logic (public/topologyGraph.js): layer
// filtering, per-type edge styling + byte-weighted width, the render view-model,
// and the layer-toggle URL round-trip. No DOM — same approach as fleetFilter.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const TG = require('../public/topologyGraph');

// A small unified graph: an L2 chain 1—2—3 plus service_dep 3→2:443 and 2→1:22.
const GRAPH = {
  nodes: [{ id: 1, label: 'a' }, { id: 2, label: 'b' }, { id: 3, label: 'c' }, { id: 4, label: 'lonely' }],
  edges: [
    { type: 'l2_link', source: 1, target: 2 },
    { type: 'l2_link', source: 2, target: 3 },
    { type: 'service_dep', source: 3, target: 2, dstPort: 443, bytes: 9000 },
    { type: 'service_dep', source: 2, target: 1, dstPort: 22, bytes: 300 },
  ],
  totals: { nodes: 4, l2_link: 2, service_dep: 2 },
};

// ---- layer filtering -------------------------------------------------------

test('filterEdges: layer selects edge type; both keeps all', () => {
  assert.equal(TG.filterEdges(GRAPH.edges, 'l2').length, 2);
  assert.equal(TG.filterEdges(GRAPH.edges, 'dep').length, 2);
  assert.equal(TG.filterEdges(GRAPH.edges, 'both').length, 4);
  // Every l2-only edge really is an l2_link.
  assert.ok(TG.filterEdges(GRAPH.edges, 'l2').every((e) => e.type === 'l2_link'));
  assert.ok(TG.filterEdges(GRAPH.edges, 'dep').every((e) => e.type === 'service_dep'));
});

test('normalizeLayer coerces junk to both', () => {
  assert.equal(TG.normalizeLayer('L2'), 'l2');
  assert.equal(TG.normalizeLayer('dep'), 'dep');
  assert.equal(TG.normalizeLayer('bogus'), 'both');
  assert.equal(TG.normalizeLayer(undefined), 'both');
});

// ---- edge styling ----------------------------------------------------------

test('edgeStyle: service_dep is dashed+directed, l2_link solid+undirected', () => {
  const dep = TG.edgeStyle({ type: 'service_dep' });
  assert.deepEqual(dep, { cls: 'dep', dashed: true, directed: true });
  const l2 = TG.edgeStyle({ type: 'l2_link' });
  assert.deepEqual(l2, { cls: 'l2', dashed: false, directed: false });
});

test('edgeWeight: service_dep scales with bytes; l2 is constant', () => {
  const max = TG.maxEdgeBytes(GRAPH.edges);
  assert.equal(max, 9000);
  const heavy = TG.edgeWeight({ type: 'service_dep', bytes: 9000 }, max, { min: 1, max: 6 });
  const light = TG.edgeWeight({ type: 'service_dep', bytes: 300 }, max, { min: 1, max: 6 });
  assert.ok(heavy > light, 'heavier dependency draws a thicker line');
  assert.ok(heavy <= 6 && light >= 1, 'width stays within bounds');
  // l2 ignores bytes entirely.
  assert.equal(TG.edgeWeight({ type: 'l2_link', bytes: 9999 }, max, { l2: 1.75 }), 1.75);
});

// ---- view model ------------------------------------------------------------

test('buildViewModel: dep layer drops the L2-only node and the isolate', () => {
  const vm = TG.buildViewModel(GRAPH, 'dep');
  assert.equal(vm.layer, 'dep');
  // service_dep touches nodes 1,2,3 — node 4 (lonely) has no edge in any layer.
  const ids = vm.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(vm.edges.length, 2);
  assert.equal(vm.maxBytes, 9000);
  // degree over the dep layer: node 2 is in both dep edges.
  assert.equal(vm.nodes.find((n) => n.id === 2).degree, 2);
});

test('buildViewModel: focus node is kept even with no edge in the layer', () => {
  const vm = TG.buildViewModel(GRAPH, 'l2', { focus: 4 });
  assert.ok(vm.nodes.find((n) => n.id === 4), 'focus/what-if node never vanishes');
});

test('buildViewModel: empty graph yields an empty model, not a throw', () => {
  const vm = TG.buildViewModel({ nodes: [], edges: [] }, 'both');
  assert.deepEqual(vm.nodes, []);
  assert.deepEqual(vm.edges, []);
  assert.equal(vm.maxBytes, 0);
});

// ---- URL round-trip --------------------------------------------------------

test('parseParams / paramsPatch round-trip the layer toggle + focus', () => {
  assert.deepEqual(TG.parseParams(''), { layer: 'both', focus: null });
  assert.deepEqual(TG.parseParams('?layer=dep&focus=7'), { layer: 'dep', focus: 7 });
  // default layer is omitted from the patch; a real layer + focus are kept.
  assert.deepEqual(TG.paramsPatch({ layer: 'both', focus: null }), { layer: null, focus: null });
  assert.deepEqual(TG.paramsPatch({ layer: 'l2', focus: 3 }), { layer: 'l2', focus: '3' });
});

test('parseParams is forgiving about junk', () => {
  assert.deepEqual(TG.parseParams('?layer=xxx&focus=-4'), { layer: 'both', focus: null });
  assert.deepEqual(TG.parseParams('not a query'), { layer: 'both', focus: null });
});
