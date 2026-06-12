'use strict';

const { isPrivate } = require('../geo/privateIp');

// AS-path derivation + change detection — the control-plane-flavoured companion to
// pathGraph.js. From a traceroute's hops it reads the *observed* AS-path (which
// autonomous systems the packets actually crossed) and flags when that path
// changes between runs.
//
// HONESTY (surfaced in the UI): this is the FORWARDING / data-plane AS-path seen
// via traceroute + offline GeoIP/ASN — NOT the BGP control-plane AS_PATH attribute.
// They usually agree but can diverge (MPLS tunnels hide hops, IXP hops, asymmetric
// return paths, anycast). We never claim a BGP feed we don't have.
//
// Local + explainable (CLAUDE.md): pure functions, fixed rules, a plain-language
// reason on every change. No ML, no cloud, metadata only (ASN + ordering).

const SEV_RANK = { ok: 0, muted: 0, warn: 1, bad: 2 };
const worse = (a, b) => ((SEV_RANK[b] || 0) > (SEV_RANK[a] || 0) ? b : a);

// Collapse a traceroute's hops into the ordered list of distinct, consecutive
// public ASNs. Private/RFC1918 hops carry no public AS and are skipped; public
// hops we can't map to an AS are skipped too but counted as `gaps`, so callers can
// be honest about how complete the observed path is.
//   extractAsPath(hops, { geoProvider }) ->
//     { sequence:[asn], segments:[{asn,asnName,country,hops:[n]}], origin, length, gaps }
function extractAsPath(hops, { geoProvider = null } = {}) {
  const segments = [];
  let gaps = 0;
  for (const h of Array.isArray(hops) ? hops : []) {
    const ip = h && h.ip;
    if (!ip || isPrivate(ip)) continue;
    const geo = geoProvider && typeof geoProvider.lookup === 'function' ? geoProvider.lookup(ip) : null;
    const asn = geo && geo.asn != null ? Number(geo.asn) : null;
    if (asn == null || !Number.isFinite(asn)) { gaps += 1; continue; } // public hop, unknown AS
    const last = segments[segments.length - 1];
    if (last && last.asn === asn) { last.hops.push(Number(h.hop)); continue; } // same AS run
    segments.push({ asn, asnName: (geo && geo.asnName) || null, country: (geo && geo.country) || null, hops: [Number(h.hop)] });
  }
  return {
    sequence: segments.map((s) => s.asn),
    segments,
    origin: segments.length ? segments[segments.length - 1].asn : null,
    length: segments.length,
    gaps,
  };
}

// Classify the difference between two AS-path sequences (arrays of ASN numbers, as
// returned by extractAsPath().sequence). Pure + order-aware. A different last
// (destination) AS is the strongest signal.
//   diffAsPath(prevSeq, curSeq) ->
//     { changed, originChanged, added:[asn], removed:[asn], lengthDelta, prevOrigin, curOrigin }
function diffAsPath(prevSeq, curSeq) {
  const a = Array.isArray(prevSeq) ? prevSeq : [];
  const b = Array.isArray(curSeq) ? curSeq : [];
  const same = a.length === b.length && a.every((v, i) => v === b[i]);
  const setA = new Set(a);
  const setB = new Set(b);
  const uniq = (xs) => xs.filter((v, i) => xs.indexOf(v) === i);
  const prevOrigin = a.length ? a[a.length - 1] : null;
  const curOrigin = b.length ? b[b.length - 1] : null;
  return {
    changed: !same,
    originChanged: prevOrigin != null && curOrigin != null && prevOrigin !== curOrigin,
    added: uniq(b.filter((v) => !setA.has(v))),
    removed: uniq(a.filter((v) => !setB.has(v))),
    lengthDelta: b.length - a.length,
    prevOrigin,
    curOrigin,
  };
}

// Re-project an already-built path graph (pathGraph.js nodes, which carry .asn from
// GeoIP enrichment) into an AS-level graph for the dashboard's "AS view". The agent
// source leads; consecutive hop-nodes in one AS collapse to a single AS-node;
// private / un-mapped hops are dropped from this projection (they stay in the hop
// view). No new lookups — purely a re-grouping of existing nodes.
//   asGraphFromNodes(nodes) ->
//     { nodes:[{index,kind,asn,asnName,country,label,hops,rttMs,lossPct,severity}], links:[{from,to,severity}] }
function asGraphFromNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const groups = [];
  const src = list.find((n) => n && n.kind === 'source');
  if (src) groups.push({ kind: 'source', asn: null, asnName: null, country: null, label: src.label || 'Agent', members: [src] });
  for (const n of list) {
    if (!n || n.kind === 'source' || n.asn == null) continue;
    const last = groups[groups.length - 1];
    if (last && last.asn === n.asn) { last.members.push(n); continue; }
    groups.push({ kind: 'transit', asn: n.asn, asnName: n.asnName || null, country: n.country || null, label: `AS${n.asn}`, members: [n] });
  }
  const outNodes = groups.map((g, i) => {
    const rtts = g.members.map((m) => m.rttMs).filter((v) => typeof v === 'number' && Number.isFinite(v));
    const losses = g.members.map((m) => m.lossPct).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return {
      index: i,
      kind: g.kind === 'source' ? 'source' : (i === groups.length - 1 ? 'dest' : 'transit'),
      asn: g.asn,
      asnName: g.asnName,
      country: g.country,
      label: g.label,
      hops: g.members.flatMap((m) => (m.hop ? [m.hop] : [])),
      // RTT into this AS ≈ the last member hop's cumulative latency; loss = worst member.
      rttMs: g.kind === 'source' ? 0 : (rtts.length ? rtts[rtts.length - 1] : null),
      lossPct: g.kind === 'source' ? 0 : (losses.length ? Math.max(...losses) : null),
      severity: g.kind === 'source' ? 'ok' : g.members.reduce((w, m) => worse(w, m.severity || 'ok'), 'ok'),
    };
  });
  const links = [];
  for (let i = 1; i < outNodes.length; i += 1) links.push({ from: outNodes[i - 1].index, to: outNodes[i].index, severity: outNodes[i].severity });
  return { nodes: outNodes, links };
}

module.exports = { extractAsPath, diffAsPath, asGraphFromNodes };
