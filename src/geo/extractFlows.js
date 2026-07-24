'use strict';

// Pulls raw flow records out of an agent result payload. Two shapes are
// supported:
//   1) traffic.flows: [{ srcIp, dstIp, proto, srcPort, dstPort, bytes, packets, flows }]
//      — the preferred, explicit schema.
//   2) traffic.topTalkers: [{ pair, bytes, packets, flows, proto }]
//      — best-effort fallback; the pair string is parsed for two IPs.
// Returns raw (un-enriched) records the geo enricher can consume.

const IPV4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d+))?/g;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Parses "1.2.3.4:443 <-> 5.6.7.8:55000" (any of ↔ <-> -> → - , |) into two
// endpoints. Returns null unless two IPv4 addresses are found.
function parsePair(pair) {
  if (typeof pair !== 'string') return null;
  const found = [];
  let m;
  IPV4.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((m = IPV4.exec(pair)) !== null) {
    found.push({ ip: m[1], port: m[2] ? Number(m[2]) : null });
    if (found.length === 2) break;
  }
  if (found.length < 2) return null;
  return { src: found[0], dst: found[1] };
}

function extractFlows(agentId, payload, now = () => new Date()) {
  const traffic = payload && payload.traffic;
  if (!traffic || typeof traffic !== 'object') return [];

  const tsRaw = payload.at || payload.ts || traffic.at || null;
  const ts = tsRaw ? new Date(tsRaw) : now();
  const records = [];

  if (Array.isArray(traffic.flows) && traffic.flows.length) {
    for (const f of traffic.flows) {
      if (!f || typeof f !== 'object') continue;
      if (!f.srcIp && !f.dstIp) continue;
      records.push({
        agentId,
        ts,
        srcIp: f.srcIp ?? null,
        dstIp: f.dstIp ?? null,
        proto: f.proto ?? f.protocol ?? null,
        srcPort: f.srcPort ?? null,
        dstPort: f.dstPort ?? null,
        bytes: num(f.bytes),
        packets: num(f.packets),
        flows: num(f.flows) || 1,
      });
    }
    return records;
  }

  if (Array.isArray(traffic.topTalkers)) {
    for (const t of traffic.topTalkers) {
      const parsed = t && parsePair(t.pair);
      if (!parsed) continue;
      records.push({
        agentId,
        ts,
        srcIp: parsed.src.ip,
        dstIp: parsed.dst.ip,
        proto: t.proto ?? t.protocol ?? null,
        srcPort: parsed.src.port,
        dstPort: parsed.dst.port,
        bytes: num(t.bytes),
        packets: num(t.packets),
        flows: num(t.flows) || 1,
      });
    }
  }

  return records;
}

module.exports = { extractFlows, parsePair };
