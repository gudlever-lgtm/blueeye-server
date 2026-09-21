'use strict';

// The switches, on the topology the Troubleshooting screen draws.
//
// WHAT WAS MISSING, AND WHY. The graph in `src/topology/graph.js` is built from
// `lldp_neighbors` (LLDP as seen BY AN AGENT), service dependencies and the
// agent rows. The switches this product polls live in `snmp_devices` and their
// LLDP lives in `snmp_neighbors`, and NEITHER was read by it — so a site with
// twelve switches drew two agents and a dotted line. Migration 106 says so in
// as many words: "The merge into the topology graph is left as its own
// decision." This is that decision.
//
// THIS MERGES THE VIEW, NOT THE BLAST-RADIUS GRAPH. Blast radius answers "what
// does this node cut off" by walking agent adjacency, and every caller of it
// keys on a numeric agent id. Putting switches into THAT graph changes every
// blast-radius answer in the product and belongs in its own change with its own
// tests. What this does is narrower and useful on its own: the picture shows
// the network, and the states on it are the ones the poller already records.
//
// NODE IDS. An agent is a number, a device is the string `d:<id>`. They are not
// the same kind of thing — migration 104's whole argument is that a polled
// switch is not an agent, with no token, no heartbeat and no version — and one
// shared numeric space would silently collide the day agent 5 and device 5 both
// exist. Which is today.
//
// HOW AN ADJACENCY IS RESOLVED. A neighbour row says "on my port X I can see
// chassis Y". Turning Y into a node means recognising it:
//
//   1. by MAC. A chassis id is normally the device's base MAC, and
//      `device_interfaces.phys_address` holds the MACs of every port we have
//      read. Normalised on both sides, this is the reliable one.
//   2. by system name, EXACTLY. Case-insensitive, whole string, against a
//      device's display name or host and an agent's hostname. Only when the MAC
//      lookup missed.
//
// There is no third rule, and in particular no substring or prefix match. A
// link that is drawn is a claim about the network; "sw-lager-1" matching
// "sw-lager-10" invents one, and an invented link on an outage screen is worse
// than a missing one because somebody acts on it.

// A MAC, or a chassis id that is one, reduced to twelve hex characters.
// Devices render them every way there is — `00:1b:44:11:3a:b7`, `001b.4411.3ab7`,
// `0x001B441 13AB7`, a raw octet string — and two spellings of the same address
// must resolve to the same node.
function normaliseMac(value) {
  if (value == null) return null;
  const hex = String(value).toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '');
  return hex.length === 12 ? hex : null;
}

// An exact, case-insensitive name. Trimmed, because a sysName read off the wire
// carries whatever padding the device felt like sending.
function nameKey(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return s || null;
}

// What a device's poll state says about it, in the same three words the agent
// nodes use.
//
// `enabled = false` is not a state on the map: an admin turned it off, it is
// not failing, and colouring it red would put a fault on the screen that nobody
// can fix. Those devices are left out entirely.
//
// A device that has NEVER answered is not 'down' either — nothing has been
// established about it yet, and the poller may simply not have reached its
// first cycle. It draws as unknown.
function deviceState(device) {
  if (!device) return null;
  if (device.enabled === false) return null;
  if (device.lastError) return 'down';
  if (device.lastOkAt) return 'ok';
  return 'unknown';
}

// Adds the polled switches and their LLDP adjacencies to a topology view.
//
//   view        { nodes, links, counts, layers } from buildTopologyView
//   devices     snmp_devices rows (repository shape)
//   neighbours  snmp_neighbors rows (repository shape)
//   deviceMacs  [{ deviceId, physAddress }] from device_interfaces
//   agents      agent rows, for the name fallback
//   agentChassis [{ chassisId, agentId }] from lldp_neighbors' local side
//
// Returns a NEW view. Pure: no I/O, no mutation of what it was given, so the
// whole thing is testable without a database or a switch.
function mergeSnmpTopology(opts) {
  // Not a destructured parameter with a default: a default only fills in for
  // `undefined`, and this runs inside the read that paints an outage screen.
  // A null handed in by a caller that meant "nothing to merge" must cost that
  // call, never the page.
  const o = opts && typeof opts === 'object' ? opts : {};
  const {
    view = null, devices = [], neighbours = [], deviceMacs = [],
    agents = [], agentChassis = [],
  } = o;
  const base = view && typeof view === 'object'
    ? view : { nodes: [], links: [], counts: {}, layers: {} };
  const arr = (v) => (Array.isArray(v) ? v : []);

  const nodeId = (deviceId) => `d:${Number(deviceId)}`;

  // The devices worth drawing, and their states.
  const drawn = new Map();
  for (const d of arr(devices)) {
    if (!d || d.id == null) continue;
    const state = deviceState(d);
    if (state === null) continue;
    drawn.set(Number(d.id), {
      id: nodeId(d.id),
      deviceId: Number(d.id),
      label: d.displayName || d.host || `device ${d.id}`,
      locationId: d.locationId == null ? null : Number(d.locationId),
      kind: 'device',
      host: d.host || null,
      status: null,
      lastSeen: d.lastOkAt || null,
      lastError: d.lastError || null,
      state,
    });
  }

  // --- the lookup tables the adjacency resolution needs --------------------
  const deviceByMac = new Map();
  for (const m of arr(deviceMacs)) {
    const mac = normaliseMac(m && m.physAddress);
    const id = m && m.deviceId != null ? Number(m.deviceId) : null;
    if (mac && id != null && drawn.has(id) && !deviceByMac.has(mac)) deviceByMac.set(mac, id);
  }
  const agentByMac = new Map();
  for (const c of arr(agentChassis)) {
    const mac = normaliseMac(c && c.chassisId);
    const id = c && c.agentId != null ? Number(c.agentId) : null;
    if (mac && id != null && !agentByMac.has(mac)) agentByMac.set(mac, id);
  }

  // Names, and only names that are UNAMBIGUOUS. Two devices called the same
  // thing make that name useless for resolution: resolving it to whichever one
  // was read first would draw a link to a device chosen by row order.
  const byName = new Map();
  const claimName = (key, target) => {
    if (!key) return;
    if (byName.has(key) && byName.get(key) !== target) byName.set(key, null); // ambiguous
    else if (!byName.has(key)) byName.set(key, target);
  };
  for (const d of drawn.values()) {
    claimName(nameKey(d.label), d.id);
    claimName(nameKey(d.host), d.id);
  }
  for (const a of arr(agents)) {
    if (!a || a.id == null) continue;
    claimName(nameKey(a.hostname), Number(a.id));
    claimName(nameKey(a.display_name), Number(a.id));
  }

  // The far end of a neighbour row, as a node id — or null when it is a device
  // this product does not monitor, which is most of what a switch can see.
  function resolveRemote(row) {
    const mac = normaliseMac(row && row.remoteChassisId);
    if (mac) {
      if (deviceByMac.has(mac)) return nodeId(deviceByMac.get(mac));
      if (agentByMac.has(mac)) return agentByMac.get(mac);
    }
    // The chassis id is sometimes the system name rather than a MAC — that is
    // what chassisIdSubtype 7 (locally assigned) usually carries.
    const named = byName.get(nameKey(row && row.remoteSysName))
      ?? byName.get(nameKey(row && row.remoteChassisId));
    return named ?? null;
  }

  // Nothing to merge leaves the view exactly as it was — including its counts,
  // which the caller's own tests pin. A fleet with no switches must not get a
  // different shape just because this ran.
  if (!drawn.size) return base;

  const nodes = arr(base.nodes).slice();
  const links = arr(base.links).slice();
  const onGraph = new Set(nodes.map((n) => String(n.id)));

  // A device is drawn whether or not it has a neighbour. A switch that answers
  // SNMP but reports no LLDP is still part of the network and still has a
  // state worth seeing; leaving it out would hide the devices most likely to
  // be misconfigured.
  for (const d of drawn.values()) {
    if (onGraph.has(d.id)) continue;
    nodes.push(d);
    onGraph.add(d.id);
  }

  const stateOf = new Map(nodes.map((n) => [String(n.id), n.state || 'ok']));
  const RANK = { down: 3, unreachable_downstream: 2, unknown: 1, ok: 0 };
  const worse = (a, b) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b);

  const seen = new Set();
  for (const row of arr(neighbours)) {
    if (!row || row.deviceId == null) continue;
    const src = Number(row.deviceId);
    if (!drawn.has(src)) continue;
    const source = nodeId(src);
    const target = resolveRemote(row);
    if (target == null) continue;
    const t = String(target);
    if (t === source || !onGraph.has(t)) continue;
    // Undirected: both ends report the same adjacency and it is one link.
    const key = source < t ? `${source}|${t}` : `${t}|${source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      layer: 'l2',
      type: 'l2_link',
      directed: false,
      source,
      target,
      dstPort: null,
      // Which port, so the map can say where to put a technician's hands.
      localIfName: row.localIfName || null,
      remotePortId: row.remotePortId || null,
      state: worse(stateOf.get(source) || 'ok', stateOf.get(t) || 'ok'),
    });
  }

  // The three canonical states are always present, because the legend names
  // them and a missing key would read as zero either way. `unknown` is added
  // only when something IS unknown: it is a state no agent can be in, and a
  // legend entry that always says 0 is a legend entry nobody reads.
  const counts = { ok: 0, down: 0, unreachable_downstream: 0 };
  for (const n of nodes) {
    const st = n.state || 'ok';
    if (counts[st] === undefined) counts[st] = 0;
    counts[st] += 1;
  }
  if (!counts.unknown) delete counts.unknown;

  return {
    ...base,
    nodes,
    links,
    counts,
    layers: {
      l2: links.filter((l) => l.layer === 'l2').length,
      l3: links.filter((l) => l.layer === 'l3').length,
    },
  };
}

module.exports = { mergeSnmpTopology, normaliseMac, nameKey, deviceState };
