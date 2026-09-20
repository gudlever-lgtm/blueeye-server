'use strict';

// Aggregates the byPort / byProtocol / topTalkers entries across a set of
// NetFlow measurements, optionally filtered to one port and/or protocol.
// `series` is the matched bytes per measurement (oldest first) and is only
// populated when a port or protocol filter is active. Pure; exported for tests.
function aggregateFlows(rows, { port = null, protocol = null } = {}) {
  const byPort = new Map();
  const byProtocol = new Map();
  const byTalker = new Map();
  const series = [];

  const bump = (map, key, e) => {
    const cur = map.get(key) || { bytes: 0, packets: 0, flows: 0 };
    cur.bytes += Number(e.bytes) || 0;
    cur.packets += Number(e.packets) || 0;
    cur.flows += Number(e.flows) || 0;
    map.set(key, cur);
  };

  for (const row of rows) {
    const t = row.payload && row.payload.traffic;
    if (!t || (!t.byPort && !t.byProtocol && !t.topTalkers)) continue;
    let matchBytes = 0;
    for (const e of t.byPort || []) {
      if (port !== null && e.port !== port) continue;
      bump(byPort, e.port, e);
      if (port !== null) matchBytes += Number(e.bytes) || 0;
    }
    for (const e of t.byProtocol || []) {
      if (protocol && String(e.protocol).toLowerCase() !== protocol) continue;
      bump(byProtocol, e.protocol, e);
      if (protocol && port === null) matchBytes += Number(e.bytes) || 0;
    }
    for (const e of t.topTalkers || []) bump(byTalker, e.pair, e);
    const at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    if (port !== null || protocol) series.push({ at, bytes: matchBytes });
  }

  const sortMap = (map, key) =>
    Array.from(map.entries())
      .map(([k, v]) => ({ [key]: k, ...v }))
      .sort((a, b) => b.bytes - a.bytes);

  return {
    byPort: sortMap(byPort, 'port'),
    byProtocol: sortMap(byProtocol, 'protocol'),
    topTalkers: sortMap(byTalker, 'pair').slice(0, 50),
    series: series.reverse(), // oldest first
  };
}

// Agents router with role-based access control:
//   - viewer+        may read         (GET)
//   - operator/admin may edit metadata (PUT — server-managed fields only)
//   - admin          may delete       (DELETE)
//
// Agents are created via enrollment (prompt 4) — there is intentionally no
// manual POST /agents here.

module.exports = { aggregateFlows };
