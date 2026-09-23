'use strict';

const { isPrivate } = require('../geo/privateIp');
const { serviceForPort } = require('../flows/services');
const { listCategories, buildIndex, classifyPort } = require('../flows/categories');

// Flow-derived dependency / topology graph — a who-talks-to-whom view built from
// the ingested 5-tuple flows (complements the per-target traceroute path graph in
// pathGraph.js and the AS-path view; this one is the service/host dependency map).
//
// Nodes are endpoints (IPs): 'internal' when RFC1918/non-routable (kept as
// topology, never geolocated) or 'external' (carrying the peer's ASN/country).
// Edges are directed src→dst conversations, weighted by bytes/packets/flows.
// Pure: no I/O. The heaviest nodes/edges win when capping for the UI.
//
// When a `centroids` lookup (src/geo/centroids.js) is injected, external nodes
// also get a country-level `lat`/`lng` so the UI can plot the public peers on a
// map. Internal (RFC1918) nodes are NEVER geolocated (privacy by design), so
// they always carry lat/lng = null — the map can only show the external subset.

//
// Edges also say WHAT they carry: `services` is the dominant service ports the
// repository found for that conversation (flowsRepository.topologyEdges), each
// named from the well-known table and classified into a traffic category, and
// `service` is the heaviest one's name. `ot` is true when any of them falls in
// the Industrial / OT category, so the UI can badge a PLC<->SCADA edge. The
// category list is injectable (`categories`, e.g. the admin-edited one) and
// defaults to the built-in list.
function describeServices(list, index) {
  return (Array.isArray(list) ? list : []).map((s) => ({
    port: Number(s.port),
    proto: s.proto ?? null,
    bytes: Number(s.bytes) || 0,
    name: serviceForPort(s.port, s.proto),
    category: classifyPort(s.port, index),
  }));
}

function buildTopology(rows, { maxNodes = 200, maxEdges = 400, centroids = null, categories = null } = {}) {
  const nodes = new Map(); // ip -> node accumulator
  const edges = new Map(); // `${from}\0${to}` -> edge accumulator
  const catIndex = buildIndex(Array.isArray(categories) && categories.length ? categories : listCategories());

  const ensureNode = (ip, extMeta) => {
    let n = nodes.get(ip);
    if (!n) {
      n = { id: ip, kind: isPrivate(ip) ? 'internal' : 'external', bytesIn: 0, bytesOut: 0, flows: 0, peers: new Set() };
      nodes.set(ip, n);
    }
    // ASN/country describe the public peer; only attach to an external node.
    if (n.kind === 'external' && extMeta) {
      if (n.asn == null && extMeta.asn != null) n.asn = extMeta.asn;
      if (!n.asnName && extMeta.asnName) n.asnName = extMeta.asnName;
      if (!n.country && extMeta.country) n.country = extMeta.country;
    }
    return n;
  };

  for (const r of Array.isArray(rows) ? rows : []) {
    const from = r && r.srcIp;
    const to = r && r.dstIp;
    if (!from || !to || from === to) continue;
    const bytes = Number(r.bytes) || 0;
    const packets = Number(r.packets) || 0;
    const flows = Number(r.flowCount ?? r.flows) || 0;
    // The record's asn/country belong to its external endpoint (ext_ip). Attach
    // them to whichever node is that external endpoint.
    const extMeta = { asn: r.asn ?? null, asnName: r.asnName ?? null, country: r.country ?? null };
    const a = ensureNode(from, r.extIp ? (r.extIp === from ? extMeta : null) : (isPrivate(from) ? null : extMeta));
    const b = ensureNode(to, r.extIp ? (r.extIp === to ? extMeta : null) : (isPrivate(to) ? null : extMeta));
    a.bytesOut += bytes; a.flows += flows; a.peers.add(to);
    b.bytesIn += bytes; b.peers.add(from);
    const key = `${from}\0${to}`;
    const e = edges.get(key) || { from, to, bytes: 0, packets: 0, flows: 0, services: [] };
    e.bytes += bytes; e.packets += packets; e.flows += flows;
    // One (src, dst) can arrive as several rows (one per ext_ip); the repository
    // attached the same per-pair service list to each, so the first one wins
    // rather than being summed twice.
    if (!e.services.length && Array.isArray(r.services) && r.services.length) {
      e.services = describeServices(r.services, catIndex);
    }
    edges.set(key, e);
  }
  for (const e of edges.values()) {
    e.service = e.services.length ? (e.services[0].name || `${e.services[0].port}/${e.services[0].proto || '?'}`) : null;
    e.ot = e.services.some((s) => s.category === 'ot');
  }

  // Country → {lat,lng} for external peers only (country-level, no city precision).
  const placeOf = (n) => (n.kind === 'external' && n.country && centroids ? centroids.get(n.country) : null);
  const nodeList = [...nodes.values()]
    .map((n) => {
      const p = placeOf(n);
      return {
        id: n.id, kind: n.kind, asn: n.asn ?? null, asnName: n.asnName ?? null, country: n.country ?? null,
        lat: p ? p.lat : null, lng: p ? p.lng : null,
        bytesIn: n.bytesIn, bytesOut: n.bytesOut, bytes: n.bytesIn + n.bytesOut, flows: n.flows, degree: n.peers.size,
      };
    })
    .sort((x, y) => y.bytes - x.bytes);
  const edgeList = [...edges.values()].sort((x, y) => y.bytes - x.bytes);

  const keptNodes = nodeList.slice(0, maxNodes);
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptEdges = edgeList.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)).slice(0, maxEdges);

  return {
    nodes: keptNodes,
    edges: keptEdges,
    truncated: keptNodes.length < nodeList.length || keptEdges.length < edgeList.length,
    totals: {
      nodes: nodeList.length,
      edges: edgeList.length,
      internal: nodeList.filter((n) => n.kind === 'internal').length,
      external: nodeList.filter((n) => n.kind === 'external').length,
    },
  };
}

module.exports = { buildTopology };
