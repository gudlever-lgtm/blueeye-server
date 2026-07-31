'use strict';

// Pure aggregation for the service-dependency graph (v1). Turns TCP flow
// aggregates (src_ip, dst_ip, dst_port, volume) into directed host↔host edges
// keyed by (src_host_id, dst_host_id, dst_port), using a host resolver to map
// each IP to a monitored host.
//
// Rules (v1 scope):
//   - TCP only, both endpoints must resolve to a monitored host — otherwise the
//     edge is DROPPED (never stored).
//   - Self-edges (src host === dst host) are dropped.
//   - Multiple IPs mapping to the same host fold into one edge.
//   - Top-N edges PER HOST by byte volume, counting a host's edges in BOTH
//     directions — an edge survives if it ranks within the Top-N heaviest edges
//     event to EITHER of its endpoint hosts (heaviest inbound OR outbound
//     relationships), so a busy server keeps the clients that lean on it even
//     when it is rarely the source. N configurable, default 50.
//
// No process attribution, no service naming/classification — just the edge.

const DEFAULT_TOP_N = 50;

function ms(v) {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function aggregateServiceDependencies(flowRows, resolver, { topN = DEFAULT_TOP_N } = {}) {
  const n = Number.isInteger(topN) && topN > 0 ? topN : DEFAULT_TOP_N;
  const resolve = resolver && typeof resolver.resolve === 'function' ? (ip) => resolver.resolve(ip) : () => null;

  const byEdge = new Map();
  const stats = { input: 0, droppedUnknown: 0, droppedSelf: 0, truncated: 0 };

  for (const r of Array.isArray(flowRows) ? flowRows : []) {
    if (!r) continue;
    stats.input += 1;
    const srcHostId = resolve(r.srcIp);
    const dstHostId = resolve(r.dstIp);
    if (srcHostId == null || dstHostId == null) { stats.droppedUnknown += 1; continue; }
    if (srcHostId === dstHostId) { stats.droppedSelf += 1; continue; }
    const dstPort = Number(r.dstPort);
    if (!Number.isInteger(dstPort) || dstPort <= 0) { stats.droppedUnknown += 1; continue; }

    const key = `${srcHostId}|${dstHostId}|${dstPort}`;
    let e = byEdge.get(key);
    if (!e) {
      e = {
        srcHostId, dstHostId, dstPort, proto: 'tcp',
        bytes: 0, packets: 0, connCount: 0,
        firstSeenMs: null, lastSeenMs: null,
      };
      byEdge.set(key, e);
    }
    e.bytes += Number(r.bytes) || 0;
    e.packets += Number(r.packets) || 0;
    e.connCount += Number(r.connCount) || 0;
    const f = ms(r.firstSeen);
    const l = ms(r.lastSeen);
    if (f != null) e.firstSeenMs = e.firstSeenMs == null ? f : Math.min(e.firstSeenMs, f);
    if (l != null) e.lastSeenMs = e.lastSeenMs == null ? l : Math.max(e.lastSeenMs, l);
  }

  // Top-N per host by bytes, in BOTH directions. Index every edge under each of
  // its two endpoint hosts, rank each host's event edges by bytes, and keep an
  // edge if it lands in the Top-N for EITHER endpoint (union).
  const event = new Map(); // hostId -> edge[]
  const addEvent = (hostId, e) => {
    if (!event.has(hostId)) event.set(hostId, []);
    event.get(hostId).push(e);
  };
  for (const e of byEdge.values()) { addEvent(e.srcHostId, e); addEvent(e.dstHostId, e); }

  const byBytesDesc = (a, b) => b.bytes - a.bytes
    || a.srcHostId - b.srcHostId || a.dstHostId - b.dstHostId || a.dstPort - b.dstPort;
  const keep = new Set();
  for (const list of event.values()) {
    list.sort(byBytesDesc);
    for (const e of list.slice(0, n)) keep.add(e);
  }
  stats.truncated = byEdge.size - keep.size;

  const edges = [...keep]
    .sort(byBytesDesc)
    .map((e) => ({
      srcHostId: e.srcHostId,
      dstHostId: e.dstHostId,
      dstPort: e.dstPort,
      proto: e.proto,
      bytes: e.bytes,
      packets: e.packets,
      connCount: e.connCount,
      firstSeen: e.firstSeenMs != null ? new Date(e.firstSeenMs) : null,
      lastSeen: e.lastSeenMs != null ? new Date(e.lastSeenMs) : null,
    }));
  stats.edges = edges.length;
  return { edges, stats };
}

module.exports = { aggregateServiceDependencies, DEFAULT_TOP_N };
