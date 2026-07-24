// public/topologyGraph.js — pure, framework-free logic for the unified topology
// map (the "Layers" mode of the Topology view). NO DOM here: it decides what the
// SVG renderer draws — which edges a layer shows, how each edge type is styled,
// node degrees for sizing, and the layer-toggle state that round-trips through
// the URL query string (the SPA's filter-persistence pattern) — so it can be
// unit-tested under `node --test` with no browser.
//
// Graph shape (GET /api/topology/graph, buildTopologyGraph):
//   { nodes:[{id,label}], edges:[ {type:'l2_link',source,target}
//                                | {type:'service_dep',source,target,dstPort,
//                                   proto,bytes,packets,connCount,...} ], totals }
//
// Two edge types share one graph:
//   - l2_link    : physical LLDP adjacency, undirected, drawn SOLID.
//   - service_dep: observed TCP dependency, directed src→dst, drawn DASHED and
//                  weighted by byte volume.
//
// Dual export: window.TopologyGraph (browser <script>) + module.exports (tests).

(function (root) {
  'use strict';

  var LAYERS = ['both', 'l2', 'dep']; // default 'both'

  function defaultState() {
    return { layer: 'both', focus: null };
  }

  function normalizeLayer(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return LAYERS.indexOf(s) !== -1 ? s : 'both';
  }

  // Parse the layer-toggle + focus node from a URL query string (forgiving: a
  // bad value degrades to the default rather than throwing).
  function parseParams(search) {
    var state = defaultState();
    var qs = String(search == null ? '' : search).replace(/^\?/, '');
    if (!qs) return state;
    var params;
    try { params = new URLSearchParams(qs); } catch (e) { return state; }
    state.layer = normalizeLayer(params.get('layer'));
    var focus = params.get('focus');
    if (focus != null && String(focus).trim() !== '') {
      var n = Number(focus);
      if (Number.isInteger(n) && n > 0) state.focus = n;
    }
    return state;
  }

  // Only the topology-owned params, so callers can merge them into an existing
  // query string without clobbering unrelated ones. Empty/default ⇒ dropped.
  function paramsPatch(state) {
    var s = state || {};
    return {
      layer: s.layer && s.layer !== 'both' ? s.layer : null,
      focus: s.focus != null ? String(s.focus) : null,
    };
  }

  function edgeType(edge) {
    return edge && edge.type === 'l2_link' ? 'l2_link' : (edge && edge.type === 'service_dep' ? 'service_dep' : null);
  }

  // Edges a layer shows: 'l2' ⇒ l2_link only, 'dep' ⇒ service_dep only, 'both' ⇒
  // every typed edge.
  function filterEdges(edges, layer) {
    var lyr = normalizeLayer(layer);
    return (Array.isArray(edges) ? edges : []).filter(function (e) {
      var t = edgeType(e);
      if (!t) return false;
      if (lyr === 'l2') return t === 'l2_link';
      if (lyr === 'dep') return t === 'service_dep';
      return true;
    });
  }

  // A pure style descriptor for one edge — the renderer turns it into SVG attrs.
  // service_dep is DASHED and directed; l2_link is SOLID and undirected.
  function edgeStyle(edge) {
    return edgeType(edge) === 'service_dep'
      ? { cls: 'dep', dashed: true, directed: true }
      : { cls: 'l2', dashed: false, directed: false };
  }

  // Stroke width for an edge. l2_link is a fixed physical link (constant weight);
  // service_dep scales by byte volume, log-compressed against the heaviest shown
  // edge, so a busy dependency reads as a thicker line. Bounded [min,max].
  function edgeWeight(edge, maxBytes, opts) {
    var o = opts || {};
    var min = o.min != null ? o.min : 1;
    var max = o.max != null ? o.max : 6;
    if (edgeType(edge) !== 'service_dep') return o.l2 != null ? o.l2 : 1.75;
    var cap = Math.max(1, Number(maxBytes) || 0);
    var b = Math.max(0, Number(edge && edge.bytes) || 0);
    var frac = Math.log2(1 + b) / Math.log2(1 + cap);
    if (!Number.isFinite(frac) || frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    return min + frac * (max - min);
  }

  function maxEdgeBytes(edges) {
    var m = 0;
    (Array.isArray(edges) ? edges : []).forEach(function (e) {
      if (edgeType(e) === 'service_dep') { var b = Number(e.bytes) || 0; if (b > m) m = b; }
    });
    return m;
  }

  // Degree of each node over a set of (already layer-filtered) edges. Used to
  // size nodes and to prune isolates from a single-layer view.
  function nodeDegrees(edges) {
    var deg = {};
    var bump = function (id) { if (id != null) deg[id] = (deg[id] || 0) + 1; };
    (Array.isArray(edges) ? edges : []).forEach(function (e) { bump(e.source); bump(e.target); });
    return deg;
  }

  // The node ids a layer actually shows: any node incident to a visible edge,
  // plus an optional always-kept id (the focus/what-if node) so it never vanishes
  // when it has no edge in the chosen layer. Returned as a plain array (stable by
  // the graph's node order).
  function visibleNodeIds(graph, layer, keepId) {
    var edges = filterEdges(graph && graph.edges, layer);
    var touched = {};
    edges.forEach(function (e) { touched[e.source] = 1; touched[e.target] = 1; });
    if (keepId != null) touched[keepId] = 1;
    var nodes = (graph && graph.nodes) || [];
    return nodes.map(function (n) { return n.id; }).filter(function (id) { return touched[id]; });
  }

  // A render-ready model for the chosen layer: the visible nodes (with degree +
  // label), the visible edges, and the max service_dep byte volume for weight
  // scaling. Pure — the SVG code lays it out and draws it.
  function buildViewModel(graph, layer, opts) {
    var o = opts || {};
    var lyr = normalizeLayer(layer);
    var edges = filterEdges(graph && graph.edges, lyr);
    var deg = nodeDegrees(edges);
    var keepId = o.focus != null ? o.focus : null;
    var visIds = {};
    visibleNodeIds(graph, lyr, keepId).forEach(function (id) { visIds[id] = 1; });
    var nodes = ((graph && graph.nodes) || []).filter(function (n) { return visIds[n.id]; })
      .map(function (n) { return { id: n.id, label: n.label != null ? n.label : String(n.id), degree: deg[n.id] || 0 }; });
    return { layer: lyr, nodes: nodes, edges: edges, maxBytes: maxEdgeBytes(edges) };
  }

  var apiObj = {
    LAYERS: LAYERS,
    defaultState: defaultState,
    normalizeLayer: normalizeLayer,
    parseParams: parseParams,
    paramsPatch: paramsPatch,
    edgeType: edgeType,
    filterEdges: filterEdges,
    edgeStyle: edgeStyle,
    edgeWeight: edgeWeight,
    maxEdgeBytes: maxEdgeBytes,
    nodeDegrees: nodeDegrees,
    visibleNodeIds: visibleNodeIds,
    buildViewModel: buildViewModel,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.TopologyGraph = apiObj;
})(typeof window !== 'undefined' ? window : null);
