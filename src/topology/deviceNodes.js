'use strict';

// What a polled switch LOOKS LIKE on the topology view: its state, and the
// label and site that go with it.
//
// The nodes and the edges are the graph's job now (src/topology/graph.js reads
// `snmp_devices` and `snmp_neighbors`, so blast radius walks the switches like
// anything else). What is left here is the part the GRAPH cannot answer,
// because it is about a poll and not about an adjacency: whether the switch is
// answering.
//
// THE THREE ANSWERS ARE NOT TWO. A switch that is failing, a switch that is
// fine and a switch that has NEVER BEEN POLLED are three different things, and
// the third one is the one a two-state model gets wrong: it has no error and
// no success, so "not down" would draw it green. Green is the one colour
// nobody looks at twice, and the switch nobody has ever reached is exactly the
// one worth looking at.
//
// A switch an admin DISABLED has no state at all. It is not failing — somebody
// turned it off — and a red dot nobody can fix is worse than no dot. The graph
// leaves those out entirely; this agrees with it.

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

module.exports = { deviceState, normaliseMac, nameKey };
