'use strict';

// The layer-2 path between two endpoints, switch by switch — "which switches
// and which ports does traffic from A to B cross?" — and the access port a MAC
// is plugged into. Pure: no I/O, no clock. src/topology/deviceLocator.js reads
// the facts and calls in here.
//
// THE SWITCH GRAPH IS THE ONE THE TOPOLOGY MAP DRAWS. Nodes are the polled
// switches (`snmp_devices`, disabled ones left out exactly as graph.js leaves
// them out); edges are the adjacencies the switches THEMSELVES report
// (`snmp_neighbors` — LLDP and CDP alike: a CDP row is just one more
// neighbour row, and its `protocol` (migration 124) rides along as evidence).
// The far end of a row is resolved the way src/topology/graph.js resolves it
// and no looser:
// by MAC against the switches' own port MACs, then by an exact system name that
// belongs to exactly one switch. An edge here is a claim about where a cable
// runs; an invented one would send somebody to the wrong wiring closet.
//
// THE ACCESS PORT IS THE ONE WITH THE FEWEST MACS THAT IS NOT AN UPLINK. A MAC
// is learned on its own access port AND on every uplink between it and each
// switch doing the reporting. The heuristic is the one the coverage report and
// the agent-offline verdict already use (src/coverage/coverageGaps.js,
// src/health/agentOfflineMonitor.js): fewest MACs behind the port, freshest
// breaking the tie — with ports that face another MANAGED switch excluded
// first, because that is a fact rather than a count.
//
// EVERY GAP IS SAID OUT LOUD. The answer is a list of hops plus a list of
// `uncertainties`, each with a code, a plain sentence and the evidence it was
// decided on. When two switches both see the endpoints but no LLDP/CDP link
// joins them, the path is not "not found": it is two known halves with a
// named gap between them — "an unmanaged switch or missing LLDP between X
// port P and Y port Q" — which is the sentence a technician can act on.
//
// Bounded: BFS stops at MAX_HOPS, and the caller bounds every read.

const { normaliseMac, nameKey } = require('./graph');
const { MULTI_MAC_PORT } = require('../coverage/coverageGaps');

// Longest switch path we will walk. A campus is rarely deeper than six; this is
// a guard against a graph built from bad data, not a design limit.
const MAX_HOPS = 32;

const portKey = (deviceId, ifName) => `${Number(deviceId)}|${String(ifName || '').trim().toLowerCase()}`;
const toMs = (v) => {
  if (v == null || v === '') return null;
  const ms = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isFinite(ms) ? ms : null;
};
const deviceLabel = (d) => (d && (d.displayName || d.host)) || (d ? `#${d.id}` : null);

// A remote port id that is itself a MAC or a bare number (LLDP portIdSubtype 3
// or 7) says nothing a technician can find on a faceplate; the description is
// then the better name.
function remotePortName(row) {
  const id = row && row.remotePortId != null ? String(row.remotePortId).trim() : '';
  const desc = row && row.remotePortDesc != null ? String(row.remotePortDesc).trim() : '';
  if (id && !normaliseMac(id) && !/^\d+$/.test(id)) return id;
  return desc || id || null;
}

// The switch graph. `neighbours` are snmp_neighbors rows (mapRow shape),
// `deviceMacs` the port MACs from device_interfaces (listMacs shape).
//
// Returns {
//   devices:  Map id -> device (enabled only),
//   adj:      Map id -> Map(otherId -> { localPort, remotePort, protocols[] }),
//   uplinks:  Set of portKey — ports that face another MANAGED switch,
//   foreign:  Map portKey -> [{ sysName, chassisId, protocol }] — neighbours on
//             a port that resolve to nothing managed (an unmanaged switch, an
//             access point, a phone, or a host running lldpd),
//   links:    number of distinct switch-to-switch links,
// }
function buildSwitchGraph({ devices = [], neighbours = [], deviceMacs = [] } = {}) {
  const byId = new Map();
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!d || d.id == null || d.enabled === false) continue;
    byId.set(Number(d.id), d);
  }
  const byMac = new Map();
  for (const m of Array.isArray(deviceMacs) ? deviceMacs : []) {
    const mac = normaliseMac(m && m.physAddress);
    const id = m && m.deviceId != null ? Number(m.deviceId) : null;
    if (mac && id != null && byId.has(id) && !byMac.has(mac)) byMac.set(mac, id);
  }
  // A name two switches share resolves to neither (graph.js, same reason).
  const byName = new Map();
  const claim = (name, id) => {
    const k = nameKey(name);
    if (!k) return;
    if (byName.has(k) && byName.get(k) !== id) byName.set(k, null);
    else if (!byName.has(k)) byName.set(k, id);
  };
  // sysName too (migration 133): it is the name a neighbour's LLDP/CDP row
  // carries for the switch, and rarely the one an admin registered it under.
  for (const d of byId.values()) { claim(d.displayName, Number(d.id)); claim(d.host, Number(d.id)); claim(d.sysName, Number(d.id)); }

  const adj = new Map();
  const uplinks = new Set();
  const foreign = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Map());
    let e = adj.get(a).get(b);
    if (!e) { e = { localPort: null, remotePort: null, protocols: [] }; adj.get(a).set(b, e); }
    return e;
  };

  for (const r of Array.isArray(neighbours) ? neighbours : []) {
    if (!r || r.deviceId == null || !byId.has(Number(r.deviceId))) continue;
    const self = Number(r.deviceId);
    const protocol = String(r.protocol || 'lldp').toLowerCase();
    const mac = normaliseMac(r.remoteChassisId);
    let other = mac ? (byMac.get(mac) ?? null) : null;
    if (other == null) other = byName.get(nameKey(r.remoteSysName)) ?? byName.get(nameKey(r.remoteChassisId)) ?? null;
    if (other == null || other === self) {
      if (other == null && r.localIfName) {
        const k = portKey(self, r.localIfName);
        if (!foreign.has(k)) foreign.set(k, []);
        foreign.get(k).push({ sysName: r.remoteSysName || null, chassisId: r.remoteChassisId || null, protocol });
      }
      continue;
    }
    // This side's port toward the other is a fact from this row. The other
    // side's port is only the neighbour's own claim — overwritten below when
    // the other switch reports the link itself.
    const fwd = link(self, other);
    if (r.localIfName) fwd.localPort = r.localIfName;
    if (!fwd.remotePort) fwd.remotePort = remotePortName(r);
    if (!fwd.protocols.includes(protocol)) fwd.protocols.push(protocol);
    const back = link(other, self);
    if (r.localIfName) back.remotePort = r.localIfName;
    if (!back.localPort) back.localPort = remotePortName(r);
    if (!back.protocols.includes(protocol)) back.protocols.push(protocol);
    if (r.localIfName) uplinks.add(portKey(self, r.localIfName));
  }
  // The far side's port, when only one side reported the link, is an uplink too.
  for (const [a, m] of adj) for (const e of m.values()) if (e.localPort) uplinks.add(portKey(a, e.localPort));

  let links = 0;
  for (const [a, m] of adj) for (const b of m.keys()) if (a < b) links += 1;
  return { devices: byId, adj, uplinks, foreign, links };
}

// The access port for one MAC, from its forwarding-table rows across every
// switch (fdb_entries mapRow shape). Returns
//   { port, rows, uplinkOnly, self }
// `port` is { deviceId, ifName, vlan, portMacCount, firstSeen, lastSeen,
// sharedPort, neighbours } or null; `self` is a switch whose OWN MAC this is
// (status 'self'/'mgmt'), which makes the endpoint that switch.
function pickAccessPort(rows, graph) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && graph.devices.has(Number(r.deviceId)));
  const own = list.find((r) => r.status === 'self' || r.status === 'mgmt');
  if (own) return { port: null, rows: list, uplinkOnly: false, self: Number(own.deviceId) };
  const usable = list.filter((r) => r.ifName && r.status !== 'invalid');
  const access = usable.filter((r) => !graph.uplinks.has(portKey(r.deviceId, r.ifName)));
  let best = null;
  for (const r of access) {
    const n = Number(r.portMacCount) || 1;
    const bn = best ? (Number(best.portMacCount) || 1) : Infinity;
    if (!best || n < bn || (n === bn && (toMs(r.lastSeen) || 0) > (toMs(best.lastSeen) || 0))) best = r;
  }
  if (!best) return { port: null, rows: list, uplinkOnly: usable.length > 0, self: null };
  const k = portKey(best.deviceId, best.ifName);
  return {
    port: {
      deviceId: Number(best.deviceId),
      ifName: best.ifName,
      vlan: Number(best.vlan) > 0 ? Number(best.vlan) : null,
      portMacCount: Number(best.portMacCount) || 1,
      firstSeen: best.firstSeen || null,
      lastSeen: best.lastSeen || null,
      // Several MACs on the "access" port: something with ports of its own is
      // between the host and this switch. Same threshold as the coverage report.
      sharedPort: (Number(best.portMacCount) || 1) >= MULTI_MAC_PORT,
      neighbours: graph.foreign.get(k) || [],
    },
    rows: list,
    uplinkOnly: false,
    self: null,
  };
}

// Shortest switch path (device ids) from `from` to `to`, or null.
function shortestPath(graph, from, to) {
  if (from == null || to == null || !graph.devices.has(from) || !graph.devices.has(to)) return null;
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  let frontier = [from];
  for (let depth = 0; depth < MAX_HOPS && frontier.length; depth += 1) {
    const next = [];
    for (const n of frontier) {
      // Sorted, so the same graph always yields the same one of two equal paths.
      const nbrs = [...((graph.adj.get(n) || new Map()).keys())].sort((a, b) => a - b);
      for (const m of nbrs) {
        if (prev.has(m)) continue;
        prev.set(m, n);
        if (m === to) {
          const path = [to];
          for (let p = n; p != null; p = prev.get(p)) path.unshift(p);
          return path;
        }
        next.push(m);
      }
    }
    frontier = next;
  }
  return null;
}

// Every switch reachable from `from`, with its hop distance.
function reachable(graph, from) {
  const dist = new Map();
  if (from == null || !graph.devices.has(from)) return dist;
  dist.set(from, 0);
  let frontier = [from];
  for (let depth = 1; depth <= MAX_HOPS && frontier.length; depth += 1) {
    const next = [];
    for (const n of frontier) {
      for (const m of (graph.adj.get(n) || new Map()).keys()) {
        if (dist.has(m)) continue;
        dist.set(m, depth);
        next.push(m);
      }
    }
    frontier = next;
  }
  return dist;
}

function uncertainty(code, severity, message, evidence = {}) {
  return { code, severity, message, evidence };
}

// The switch on the near side of a gap: inside `component`, the switch that has
// the FAR endpoint's MAC on a port that leads out of the managed graph (not an
// uplink to another managed switch). Nearest to `origin` first.
function borderSwitch(graph, component, farRows) {
  let best = null;
  for (const r of Array.isArray(farRows) ? farRows : []) {
    if (!r || !r.ifName) continue;
    const id = Number(r.deviceId);
    if (!component.has(id)) continue;
    if (graph.uplinks.has(portKey(id, r.ifName))) continue;
    const d = component.get(id);
    if (!best || d < best.dist || (d === best.dist && (toMs(r.lastSeen) || 0) > (toMs(best.row.lastSeen) || 0))) {
      best = { deviceId: id, ifName: r.ifName, dist: d, row: r };
    }
  }
  return best;
}

// Where each endpoint's MAC sits on switch `id` — the VLANs "seen for the
// endpoints' MACs" and the raw material for the consistency check.
function sightingsOn(id, ends) {
  const out = [];
  for (const [role, end] of Object.entries(ends)) {
    for (const r of (end && end.rows) || []) {
      if (!r || Number(r.deviceId) !== id) continue;
      out.push({ endpoint: role, mac: r.mac || null, ifName: r.ifName || null, vlan: Number(r.vlan) > 0 ? Number(r.vlan) : null, lastSeen: r.lastSeen || null });
    }
  }
  return out;
}

const sameName = (a, b) => a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// One run of connected switches as hops. `ingress` is the port the run is
// entered on at its first switch, `egress` the port it leaves on at its last.
function hopsFor(graph, ids, { ingress, egress, ingressRole, egressRole, ends }) {
  const hops = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const d = graph.devices.get(id);
    const inPort = i === 0 ? ingress : ((graph.adj.get(id) || new Map()).get(ids[i - 1]) || {}).localPort || null;
    const outPort = i === ids.length - 1 ? egress : ((graph.adj.get(id) || new Map()).get(ids[i + 1]) || {}).localPort || null;
    const viaIn = i === 0 ? null : (graph.adj.get(ids[i - 1]) || new Map()).get(id) || null;
    const sightings = sightingsOn(id, ends);
    hops.push({
      type: 'switch',
      deviceId: id,
      name: deviceLabel(d),
      host: d.host || null,
      // SNMPv2-MIB sysLocation (migration 126) — "Bygning 3, rum 2.14" — the
      // only place the network says where a switch is below the site.
      sysLocation: d.sysLocation ?? null,
      siteId: d.locationId == null ? null : Number(d.locationId),
      ingress: { ifName: inPort, role: i === 0 ? ingressRole : 'uplink' },
      egress: { ifName: outPort, role: i === ids.length - 1 ? egressRole : 'uplink' },
      // How the link INTO this hop is known: which protocol(s) reported it.
      linkProtocols: viaIn ? viaIn.protocols.slice() : [],
      sightings,
    });
  }
  return hops;
}

// Checks a run of hops against the forwarding tables: on every switch, A's MAC
// should be learned toward A (the ingress side) and B's toward B. A MAC on a
// THIRD port is evidence the LLDP picture and the FDB disagree — a stale entry,
// a loop, or a link the graph does not know about.
function consistency(hops, dirA, dirB) {
  const out = [];
  for (const h of hops) {
    if (h.type !== 'switch') continue;
    for (const s of h.sightings) {
      const expect = s.endpoint === dirA ? h.ingress.ifName : s.endpoint === dirB ? h.egress.ifName : null;
      if (!expect || !s.ifName) continue;
      if (!sameName(expect, s.ifName)) {
        out.push({ deviceId: h.deviceId, name: h.name, endpoint: s.endpoint, expected: expect, seenOn: s.ifName, vlan: s.vlan });
      }
    }
  }
  return out;
}

// The L2 path between two LOCATED endpoints. `a`/`b` are
//   { label, location: { deviceId, ifName, vlan, self } | null, rows: [fdb rows for its MACs] }
// Returns { hops, complete, uncertainties }.
function computeSegment(graph, a, b, { names = ['from', 'to'] } = {}) {
  const [nameA, nameB] = names;
  const uncertainties = [];
  const la = a && a.location;
  const lb = b && b.location;
  if (!la || !lb) {
    return { hops: [], complete: false, uncertainties };
  }
  const ends = { [nameA]: a, [nameB]: b };
  const roleOf = (loc) => (loc.self ? 'self' : 'access');
  const direct = shortestPath(graph, la.deviceId, lb.deviceId);
  if (direct) {
    const hops = hopsFor(graph, direct, {
      ingress: la.ifName || null, egress: lb.ifName || null, ingressRole: roleOf(la), egressRole: roleOf(lb), ends,
    });
    for (const c of consistency(hops, nameA, nameB)) {
      uncertainties.push(uncertainty('fdbDisagrees', 'warn',
        `${c.name} has ${c.endpoint === nameA ? a.label : b.label}'s MAC on ${c.seenOn}, but the neighbour links say it should be on ${c.expected} — a stale forwarding entry, a loop, or a link LLDP/CDP does not report.`,
        c));
    }
    return { hops, complete: true, uncertainties };
  }

  // No managed path. Find the two halves and the gap between them.
  const compA = reachable(graph, la.deviceId);
  const compB = reachable(graph, lb.deviceId);
  const x = borderSwitch(graph, compA, b.rows);
  const y = borderSwitch(graph, compB, a.rows);
  const startA = x ? x.deviceId : la.deviceId;
  const startB = y ? y.deviceId : lb.deviceId;
  const left = shortestPath(graph, la.deviceId, startA) || [la.deviceId];
  const right = shortestPath(graph, startB, lb.deviceId) || [lb.deviceId];
  const hopsA = hopsFor(graph, left, {
    ingress: la.ifName || null, egress: x ? x.ifName : null, ingressRole: roleOf(la), egressRole: 'gap', ends,
  });
  const hopsB = hopsFor(graph, right, {
    ingress: y ? y.ifName : null, egress: lb.ifName || null, ingressRole: 'gap', egressRole: roleOf(lb), ends,
  });
  const dx = graph.devices.get(startA);
  const dy = graph.devices.get(startB);
  const gapEvidence = {
    fromDeviceId: startA, fromName: deviceLabel(dx), fromPort: x ? x.ifName : null,
    toDeviceId: startB, toName: deviceLabel(dy), toPort: y ? y.ifName : null,
    fromNeighbours: x ? (graph.foreign.get(portKey(startA, x.ifName)) || []) : [],
    toNeighbours: y ? (graph.foreign.get(portKey(startB, y.ifName)) || []) : [],
  };
  let gapReason;
  if (x && y) {
    const seen = [...gapEvidence.fromNeighbours, ...gapEvidence.toNeighbours].map((n) => n.sysName || n.chassisId).filter(Boolean);
    gapReason = 'missingLink';
    uncertainties.push(uncertainty('missingLink', 'warn',
      `No LLDP/CDP link joins ${gapEvidence.fromName} (${x.ifName}) and ${gapEvidence.toName} (${y.ifName}), yet each has the other side's endpoint behind that port — an unmanaged switch or missing LLDP between them${seen.length ? ` (neighbour reported there: ${[...new Set(seen)].join(', ')})` : ''}.`,
      gapEvidence));
  } else {
    gapReason = 'noAdjacency';
    uncertainties.push(uncertainty('noAdjacency', 'warn',
      `${gapEvidence.fromName} and ${gapEvidence.toName} are not connected by any link the switches report, and ${!x ? `no switch on ${a.label}'s side has ${b.label}'s MAC on a port leading out` : `no switch on ${b.label}'s side has ${a.label}'s MAC on a port leading out`} — the path between them runs through equipment this server does not poll.`,
      gapEvidence));
  }
  const gap = {
    type: 'gap',
    reason: gapReason,
    from: { deviceId: startA, name: gapEvidence.fromName, ifName: gapEvidence.fromPort },
    to: { deviceId: startB, name: gapEvidence.toName, ifName: gapEvidence.toPort },
    neighbours: [...gapEvidence.fromNeighbours, ...gapEvidence.toNeighbours],
  };
  // The halves are in different components (else `direct` would have found a
  // path), so no switch is drawn twice.
  return { hops: [...hopsA, gap, ...hopsB], complete: false, uncertainties };
}

module.exports = {
  buildSwitchGraph,
  pickAccessPort,
  shortestPath,
  reachable,
  computeSegment,
  remotePortName,
  portKey,
  MAX_HOPS,
  MULTI_MAC_PORT,
};
