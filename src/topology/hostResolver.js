'use strict';

// Resolves an observed flow IP back to the monitored host it belongs to, so the
// service-dependency job can turn IP↔IP flows into host↔host edges and DROP any
// edge whose endpoint is not a monitored host.
//
// A "monitored host" is always an `agents` row. Two identity sources, both
// already reported by the agent (no new inventory):
//   1. capabilities.ips[]        — the agent's OWN interface addresses
//      (blueeye-agent src/localIps.js), i.e. "this agent IS this IP".
//   2. monitor_config.snmp.host  — the IP of the SNMP-monitored device this
//      agent polls (an SNMP device is represented by an agent id).
//
// Pure: it takes the agent list and returns a lookup. On a duplicate IP the
// FIRST agent to claim it wins (deterministic; conflicts are rare and a stable
// choice keeps the graph reproducible across runs).

function asObject(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return null;
}

function isIpish(s) {
  return typeof s === 'string' && s.length > 0 && /^[0-9a-fA-F.:]+$/.test(s) && /[.:]/.test(s);
}

function buildHostResolver(agents) {
  const ipToHost = new Map();
  const claim = (ip, hostId) => {
    if (!isIpish(ip)) return;
    const key = ip.trim().toLowerCase();
    if (!key || ipToHost.has(key)) return; // first claimant wins
    ipToHost.set(key, hostId);
  };

  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || a.id == null) continue;
    const hostId = Number(a.id);
    const caps = asObject(a.capabilities);
    if (caps && Array.isArray(caps.ips)) {
      for (const ip of caps.ips) claim(ip, hostId);
    }
    const mc = asObject(a.monitor_config);
    if (mc && mc.source === 'snmp' && mc.snmp && typeof mc.snmp.host === 'string') {
      claim(mc.snmp.host, hostId);
    }
  }

  function resolve(ip) {
    if (typeof ip !== 'string') return null;
    return ipToHost.get(ip.trim().toLowerCase()) ?? null;
  }

  return { resolve, size: ipToHost.size };
}

module.exports = { buildHostResolver };
