'use strict';

// The unified topology graph model. ONE host-keyed node/edge structure that
// carries BOTH edge types — this is the "extend the existing model, don't fork
// it" contract:
//   - 'l2_link'    : physical adjacency from LLDP/CDP (lldp_neighbors, mig 063),
//                    undirected agent↔agent.
//   - 'service_dep': observed TCP service dependency (service_dependencies,
//                    mig 066), directed src→dst on a dst_port.
//
// Nodes are the monitored things: AGENTS, keyed by agent id, and the POLLED
// SWITCHES, keyed `d:<id>` (src/topology/nodeId.js says why the two id spaces
// are not one). Pure: no I/O.
//
// THE SWITCHES USED TO BE ABSENT. `snmp_devices` and `snmp_neighbors`
// (migrations 104 and 106) were never read here, so a site with twelve
// switches produced a graph of two agents — and blast radius, which is built
// on this graph, could not answer "what does this switch cut off" because the
// switch was not in it. Migration 106 left that merge as its own decision;
// this is it.
//
// A SWITCH'S ADJACENCY IS RESOLVED, NOT ASSUMED. A neighbour row says "on my
// port X I can see chassis Y", and Y becomes an edge only when it is
// recognised — by MAC against the port MACs already read into
// `device_interfaces`, or by an exact, unambiguous system name. Never by
// anything looser: an edge here is a claim about the network, blast radius
// turns it into "these hosts lose connectivity", and an invented edge on an
// outage screen is worse than a missing one because somebody acts on it.
//
//   buildTopologyGraph({ l2, serviceDeps, agents, devices, deviceNeighbours, deviceMacs })
//     -> { nodes:[{id,label,kind}], edges:[{type,...}], totals }

const { deviceNode, key: nodeKey } = require('./nodeId');

// A MAC, or a chassis id that is one, reduced to twelve hex characters.
// Devices render them every way there is — `00:1b:44:11:3a:b7`,
// `001b.4411.3ab7`, `0x001B44113AB7` — and two spellings of one address must
// reach one node.
function normaliseMac(value) {
  if (value == null) return null;
  const hex = String(value).toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '');
  return hex.length === 12 ? hex : null;
}

// An exact, case-insensitive name. Trimmed, because a sysName read off the
// wire carries whatever padding the device felt like sending.
function nameKey(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return s || null;
}

function buildTopologyGraph({
  l2 = [], serviceDeps = [], agents = [],
  devices = [], deviceNeighbours = [], deviceMacs = [],
} = {}) {
  const labelById = new Map();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (a && a.id != null) labelById.set(Number(a.id), a.display_name || a.hostname || `agent ${a.id}`);
  }

  const nodes = new Map(); // node key -> node
  const ensureNode = (id) => {
    const k = nodeKey(id);
    let n = nodes.get(k);
    if (!n) {
      const num = Number(id);
      n = {
        id: num,
        label: labelById.has(num) ? labelById.get(num) : `agent ${num}`,
        kind: 'agent',
      };
      nodes.set(k, n);
    }
    return n;
  };

  // The polled switches. Drawn whether or not they report a neighbour: one
  // that answers SNMP and reports no LLDP is still part of the network, and
  // leaving it out would hide exactly the devices most likely to be
  // misconfigured.
  //
  // A switch an admin DISABLED is left out. It is not failing, and a node on
  // the map that nothing polls is a node nobody can act on.
  const deviceIds = new Set();
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!d || d.id == null || d.enabled === false) continue;
    const id = deviceNode(d.id);
    deviceIds.add(Number(d.id));
    nodes.set(nodeKey(id), {
      id,
      label: d.displayName || d.host || `device ${d.id}`,
      kind: 'device',
      host: d.host || null,
      locationId: d.locationId == null ? null : Number(d.locationId),
    });
  }

  const edges = [];

  // ---- l2_link edges (undirected agent↔agent from LLDP) --------------------
  // Resolve a neighbor's remote_chassis_id back to the agent that owns that
  // chassis, then emit one undirected edge per host pair (deduped).
  const chassisToAgent = new Map();
  for (const r of Array.isArray(l2) ? l2 : []) {
    if (r && r.localChassisId && r.localAgentId != null) {
      chassisToAgent.set(String(r.localChassisId), Number(r.localAgentId));
    }
  }
  const seenL2 = new Set();
  for (const r of Array.isArray(l2) ? l2 : []) {
    if (!r || r.localAgentId == null || !r.remoteChassisId) continue;
    const a = Number(r.localAgentId);
    const b = chassisToAgent.get(String(r.remoteChassisId));
    if (b == null || a === b) continue; // remote isn't a monitored host, or self
    const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenL2.has(pair)) continue;
    seenL2.add(pair);
    ensureNode(a); ensureNode(b);
    edges.push({ type: 'l2_link', directed: false, source: a, target: b });
  }

  // ---- service_dep edges (directed src→dst on a port) ----------------------
  for (const e of Array.isArray(serviceDeps) ? serviceDeps : []) {
    if (!e || e.srcHostId == null || e.dstHostId == null) continue;
    const src = Number(e.srcHostId);
    const dst = Number(e.dstHostId);
    ensureNode(src); ensureNode(dst);
    edges.push({
      type: 'service_dep',
      directed: true,
      source: src,
      target: dst,
      dstPort: Number(e.dstPort),
      proto: e.proto || 'tcp',
      bytes: Number(e.bytes) || 0,
      packets: Number(e.packets) || 0,
      connCount: Number(e.connCount) || 0,
      firstSeen: e.firstSeen ?? null,
      lastSeen: e.lastSeen ?? null,
    });
  }

  // ---- l2_link edges from the SWITCHES' own LLDP ---------------------------
  // The far end of a switch's neighbour row, resolved to a node — by MAC
  // first, then by an exact name that belongs to exactly one thing. A name two
  // devices share resolves to neither: picking one would draw the link to
  // whichever row was read first, which is an adjacency chosen by row order.
  const deviceByMac = new Map();
  for (const m of Array.isArray(deviceMacs) ? deviceMacs : []) {
    const mac = normaliseMac(m && m.physAddress);
    const id = m && m.deviceId != null ? Number(m.deviceId) : null;
    if (mac && id != null && deviceIds.has(id) && !deviceByMac.has(mac)) deviceByMac.set(mac, deviceNode(id));
  }
  // An agent's own chassis, from the local side of the rows read above — so a
  // switch that sees an agent joins the two clouds into one map.
  const agentByMac = new Map();
  for (const r of Array.isArray(l2) ? l2 : []) {
    const mac = normaliseMac(r && r.localChassisId);
    if (mac && r.localAgentId != null && !agentByMac.has(mac)) agentByMac.set(mac, Number(r.localAgentId));
  }

  const byName = new Map();
  const claimName = (name, target) => {
    const k = nameKey(name);
    if (!k) return;
    if (byName.has(k) && nodeKey(byName.get(k)) !== nodeKey(target)) byName.set(k, null); // ambiguous
    else if (!byName.has(k)) byName.set(k, target);
  };
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!d || d.id == null || !deviceIds.has(Number(d.id))) continue;
    claimName(d.displayName, deviceNode(d.id));
    claimName(d.host, deviceNode(d.id));
  }
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || a.id == null) continue;
    claimName(a.hostname, Number(a.id));
    claimName(a.display_name, Number(a.id));
  }

  for (const r of Array.isArray(deviceNeighbours) ? deviceNeighbours : []) {
    if (!r || r.deviceId == null || !deviceIds.has(Number(r.deviceId))) continue;
    const source = deviceNode(r.deviceId);
    const mac = normaliseMac(r.remoteChassisId);
    let target = null;
    if (mac) target = deviceByMac.get(mac) ?? agentByMac.get(mac) ?? null;
    if (target == null) {
      // A chassis id is sometimes the system name rather than a MAC — that is
      // what chassisIdSubtype 7 (locally assigned) usually carries.
      target = byName.get(nameKey(r.remoteSysName)) ?? byName.get(nameKey(r.remoteChassisId)) ?? null;
    }
    if (target == null) continue; // a neighbour this product does not monitor
    // An AGENT the switch can see becomes a node here if it was not one
    // already: this graph has always created a node when an edge justifies it,
    // and an agent with no LLDP of its own is still on the network when a
    // switch reports seeing it.
    if (typeof target === 'number') ensureNode(target);
    const a = nodeKey(source);
    const b = nodeKey(target);
    if (a === b || !nodes.has(b)) continue;
    const dedupe = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenL2.has(dedupe)) continue;
    seenL2.add(dedupe);
    edges.push({
      type: 'l2_link',
      directed: false,
      source,
      target,
      // Which port, so a map can say where to put a technician's hands.
      localIfName: r.localIfName || null,
      remotePortId: r.remotePortId || null,
    });
  }

  const l2Count = edges.filter((e) => e.type === 'l2_link').length;
  return {
    nodes: [...nodes.values()],
    edges,
    totals: { nodes: nodes.size, l2_link: l2Count, service_dep: edges.length - l2Count },
  };
}

module.exports = { buildTopologyGraph, normaliseMac, nameKey };
