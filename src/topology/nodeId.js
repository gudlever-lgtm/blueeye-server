'use strict';

// What a topology node's id IS, now that the graph holds two kinds of thing.
//
// THE PROBLEM THIS SOLVES. Nodes used to be "a number that is an agent id",
// and every consumer said `Number(e.source)` to get one. Then the polled
// switches went on the map, and a switch is not an agent — migration 104's
// whole argument is that it has no token, no heartbeat, no version and no
// self-update, and that modelling it as an agent means teaching every fleet
// rollup and licence count to exclude it. It follows that it cannot share the
// agent id space either: agent 5 and device 5 both exist, and a single number
// cannot mean both.
//
// SO AN AGENT IS STILL A NUMBER AND A DEVICE IS `d:<id>`.
//
// Not `a:5` and `d:5`. Namespacing both sides would be tidier on paper and it
// would break every existing caller at once — the blast-radius URL an operator
// has open, the host ids in stored findings, the client's own state. The
// asymmetry is the cost of not rewriting the meaning of an id that is already
// in the product's data. It is written down here, in one place, rather than
// re-derived by each caller.
//
// EVERY COMPARISON GOES THROUGH `key`. A Map keyed on a raw id would hold 5 and
// '5' as two entries, and the day an id arrives as a string from a URL or JSON
// that is a node that silently stops matching itself.

const DEVICE_PREFIX = 'd:';

// The canonical string form, for map keys, set membership and equality.
// Everything internal compares these; nothing compares raw ids.
function key(id) {
  return id == null ? '' : String(id);
}

// The id for a polled switch (`snmp_devices.id`).
function deviceNode(deviceId) {
  return `${DEVICE_PREFIX}${Number(deviceId)}`;
}

// The id for an agent. Kept as a Number so existing callers, stored ids and
// URLs keep working unchanged.
function agentNode(agentId) {
  // Integer, not "finite": `Number(null)`, `Number('')` and `Number([])` are
  // all 0, and node zero is a node that does not exist being treated as one
  // that does.
  const n = Number(agentId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isDevice(id) {
  return key(id).startsWith(DEVICE_PREFIX);
}

// The `snmp_devices.id` behind a device node, or null for anything else.
function deviceIdOf(id) {
  if (!isDevice(id)) return null;
  const n = Number(key(id).slice(DEVICE_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

// An agent id, or null when the node is not an agent. A device node is NOT an
// agent even though `Number('d:5')` is NaN — the check is explicit so a caller
// cannot get a NaN into a query by accident.
function agentIdOf(id) {
  if (id == null || isDevice(id)) return null;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Agents first, in numeric order, then devices in numeric order. A stable
// order matters because it is what the API returns and what the tests pin;
// `a - b` over mixed ids is NaN, which makes a sort do nothing at all and do
// it silently.
function compare(a, b) {
  const aDev = isDevice(a);
  const bDev = isDevice(b);
  if (aDev !== bDev) return aDev ? 1 : -1;
  const an = aDev ? deviceIdOf(a) : Number(a);
  const bn = bDev ? deviceIdOf(b) : Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return key(a).localeCompare(key(b));
}

// Turns whatever arrived — a number, a numeric string, `d:5` — into the id this
// graph uses, or null when it is not an id at all. This is what a route uses on
// a path parameter: a blast-radius URL carries `12` or `d%3A5`.
function parse(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith(DEVICE_PREFIX)) {
    const n = deviceIdOf(s);
    return n === null ? null : deviceNode(n);
  }
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = {
  DEVICE_PREFIX, key, deviceNode, agentNode, isDevice, deviceIdOf, agentIdOf, compare, parse,
};
