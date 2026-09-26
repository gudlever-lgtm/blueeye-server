'use strict';

const crypto = require('crypto');
const { buildSwitchGraph } = require('../topology/l2Path');

// The link-MTU mismatch indicator: two switch ports that LLDP or CDP says are
// cabled to each other, configured with different MTUs.
//
// WHY THIS IS WORTH ITS OWN RULE. The `path_mtu` probe already measures what a
// path carries and proves that large packets vanish while small ones pass. What
// it cannot say is which device is configured wrong: its answer is a hop
// number, and a hop is a router rather than a port. This rule answers the other
// half from the inventory the topology poll already collects — one named port
// on one named switch, and the number to change it to.
//
// The fault it names is the one that makes a healthy-looking network unusable.
// A link with 9216 on one end and 1500 on the other forwards every small frame
// perfectly: ping answers, the TCP handshake completes, DNS resolves, the
// interface counters look clean. The first full-size frame is silently too big
// for the smaller end, and the application stalls with nothing in any log.
//
// WHAT IS DELIBERATELY NOT A FINDING:
//
//   * A port whose MTU nobody knows. `null` means the device did not answer or
//     does not implement ifMtu, and it is excluded from every comparison here.
//     Reading it as 1500 would invent the fault on every silent platform in the
//     estate.
//   * A link only one switch reports. The comparison needs BOTH ends' rows;
//     when the far end is an unmanaged switch, an access point or a host, there
//     is no second MTU and nothing to compare.
//   * Two ports on one switch with different MTUs. A loopback, a tunnel and a
//     management port legitimately differ from a data port, which is exactly
//     why this compares LINKED ports and never a device's ports against each
//     other.
//   * A difference inside TOLERANCE. Platforms disagree about whether ifMtu
//     counts the ethernet header, the FCS or the 802.1Q tag, so two ends of a
//     correctly configured link routinely report numbers a few bytes apart.
//     Below the tolerance it is a units difference, not a misconfiguration.
//
// Pure: devices, neighbours, port MACs and interface rows in, findings out. No
// database, no clock — `at` is passed in, the way every evaluator here takes it.

// How far apart two ends may be before it is called a mismatch. 18 bytes covers
// the ethernet header (14) plus the FCS (4), and 22 the same with a 802.1Q tag,
// which is the widest honest disagreement between two vendors describing one
// correctly configured link.
const MTU_TOLERANCE = 22;

// One finding per link per this long. A mismatch lasts until somebody changes a
// setting, and the topology poll runs every minute.
const REFRACTORY_MINUTES = 360;

const label = (d) => (d && (d.displayName || d.host || d.sysName)) || (d ? `device ${d.id}` : 'an unknown device');
const key = (ifName) => String(ifName || '').trim().toLowerCase();

// interfaces -> Map `${deviceId}|${lowercased ifName}` -> row, for the lookup
// each end of a link needs. The name is the identity of an interface row
// (migration 108), and LLDP reports a port name, so the join is by name.
function indexInterfaces(interfaces) {
  const byPort = new Map();
  for (const i of Array.isArray(interfaces) ? interfaces : []) {
    if (!i || i.deviceId == null || !i.ifName) continue;
    byPort.set(`${Number(i.deviceId)}|${key(i.ifName)}`, i);
  }
  return byPort;
}

// A stable identity for one LINK, independent of which end is reported first.
// Both switches report the same cable, so without this the same fault is raised
// twice — once per direction — and refracted separately.
function linkId(a, b) {
  const ends = [`${a.deviceId}|${key(a.ifName)}`, `${b.deviceId}|${key(b.ifName)}`].sort();
  return ends.join('::');
}

// Every adjacency whose two ends both resolve to a port with a known MTU.
// Returns [{ low, high, protocols }] where low/high are
// { deviceId, device, ifName, ifAlias, mtu } and `low` is the smaller MTU — the
// end that decides what the link can carry, and therefore the end a technician
// is most likely to be changing.
function linksWithBothMtus({ devices = [], neighbours = [], deviceMacs = [], interfaces = [] } = {}) {
  const graph = buildSwitchGraph({ devices, neighbours, deviceMacs });
  const byPort = indexInterfaces(interfaces);
  const out = [];
  const seen = new Set();

  for (const [aId, edges] of graph.adj) {
    for (const [bId, edge] of edges) {
      if (!edge || !edge.localPort || !edge.remotePort) continue;
      const a = byPort.get(`${aId}|${key(edge.localPort)}`);
      const b = byPort.get(`${bId}|${key(edge.remotePort)}`);
      // An end whose MTU is unknown is not half a fault; it is no evidence.
      if (!a || !b || !(a.mtu > 0) || !(b.mtu > 0)) continue;
      const endA = {
        deviceId: aId, device: graph.devices.get(aId) || null, ifName: a.ifName, ifAlias: a.ifAlias || null, mtu: Number(a.mtu),
      };
      const endB = {
        deviceId: bId, device: graph.devices.get(bId) || null, ifName: b.ifName, ifAlias: b.ifAlias || null, mtu: Number(b.mtu),
      };
      const id = linkId(endA, endB);
      if (seen.has(id)) continue; // the same cable, reported from its other end
      seen.add(id);
      const [low, high] = endA.mtu <= endB.mtu ? [endA, endB] : [endB, endA];
      out.push({ id, low, high, protocols: edge.protocols || [] });
    }
  }
  return out;
}

// Returns null, or { gap } when this link is the indicator.
function detectLinkMtuMismatch(link, { tolerance = MTU_TOLERANCE } = {}) {
  if (!link || !link.low || !link.high) return null;
  const gap = link.high.mtu - link.low.mtu;
  if (!(gap > tolerance)) return null;
  return { gap };
}

function explain(link, { gap }) {
  const lowWhere = `${link.low.ifName} on ${label(link.low.device)}`;
  const highWhere = `${link.high.ifName} on ${label(link.high.device)}`;
  const how = link.protocols && link.protocols.length
    ? link.protocols.map((p) => p.toUpperCase()).join('/')
    : 'LLDP';
  return `${highWhere} is configured for an MTU of ${link.high.mtu}, but ${lowWhere} — the port `
    + `${how} says it is cabled to — is configured for ${link.low.mtu}. The link can only carry `
    + `${link.low.mtu} bytes, so the ${gap} bytes of difference are frames the larger end will send and `
    + 'the smaller end will drop. Nothing reports an error for them: small frames pass, so ping answers, '
    + 'the TCP handshake completes and the interface counters look clean, and the first full-size frame '
    + 'is where an application stalls with no message anywhere. '
    + `Fix: set both ends to the same MTU — raise ${lowWhere} to ${link.high.mtu}, or lower ${highWhere} `
    + `to ${link.low.mtu}, whichever matches the rest of the path.`;
}

// Builds the finding for one link. `hostId` is the polling agent, like every
// other switch finding (migration 110). It is attributed to the SMALLER end:
// that is the port whose configuration decides what the link carries, and the
// one a technician opens first.
function buildLinkMtuFinding(link, verdict, { hostId, interfaceId = null, at = new Date() } = {}) {
  const metric = `link.${link.id}.mtu.mismatch`;
  return {
    id: crypto.randomUUID(),
    hostId: String(hostId),
    deviceId: Number(link.low.deviceId),
    interfaceId: interfaceId == null ? null : Number(interfaceId),
    metric,
    // WARN, not CRIT: the link forwards traffic, and most of it arrives. It is
    // the fault that costs a site a fortnight of "the network is fine, the
    // application is broken", not the one that takes a site down.
    severity: 'WARN',
    kind: 'THRESHOLD',
    observed: link.low.mtu,
    baseline: link.high.mtu,
    deviation: verdict.gap,
    window: [at, at],
    explanation: explain(link, verdict),
    evidence: [{
      hostId: String(hostId),
      deviceId: Number(link.low.deviceId),
      interfaceId: interfaceId == null ? null : Number(interfaceId),
      metric,
      value: link.low.mtu,
      ts: at,
      labels: {
        lowDevice: label(link.low.device),
        lowPort: link.low.ifName,
        lowMtu: link.low.mtu,
        highDevice: label(link.high.device),
        highPort: link.high.ifName,
        highMtu: link.high.mtu,
        gapBytes: verdict.gap,
        protocols: (link.protocols || []).join(','),
      },
    }],
    correlatedWith: [],
    createdAt: at,
    acked: false,
  };
}

module.exports = {
  linksWithBothMtus, detectLinkMtuMismatch, buildLinkMtuFinding,
  MTU_TOLERANCE, REFRACTORY_MINUTES,
};
