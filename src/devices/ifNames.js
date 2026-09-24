'use strict';

// A port's identity on a switch is its NAME (migration 108: UNIQUE (device_id,
// if_name)). Some devices report the same ifName on two ifIndexes — a real HPE
// ProCurve 6120XG lists "lo0" at ifIndex 4170 and 4179 — and without this the
// second row overwrote the first and both ports' counters landed on one row.
//
// Within ONE poll of one device, a name used more than once keeps its plain form
// on the LOWEST ifIndex; every other occurrence becomes "<name> (ifIndex N)".
// The rule depends only on what the device reported, so the topology poll and
// the counter poll derive the same names independently and a counter still
// finds its port. Rows without a name or ifIndex are passed through untouched.
function disambiguateIfNames(interfaces) {
  if (!Array.isArray(interfaces) || interfaces.length < 2) return interfaces;
  const lowest = new Map(); // name -> lowest ifIndex carrying it
  const count = new Map();
  for (const i of interfaces) {
    if (!i || !i.ifName || !Number.isInteger(Number(i.ifIndex))) continue;
    const idx = Number(i.ifIndex);
    count.set(i.ifName, (count.get(i.ifName) || 0) + 1);
    if (!lowest.has(i.ifName) || idx < lowest.get(i.ifName)) lowest.set(i.ifName, idx);
  }
  let changed = false;
  const out = interfaces.map((i) => {
    if (!i || !i.ifName || (count.get(i.ifName) || 0) < 2) return i;
    const idx = Number(i.ifIndex);
    if (!Number.isInteger(idx) || idx === lowest.get(i.ifName)) return i;
    changed = true;
    return { ...i, ifName: `${i.ifName} (ifIndex ${idx})` };
  });
  return changed ? out : interfaces;
}

module.exports = { disambiguateIfNames };
