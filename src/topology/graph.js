'use strict';

// The unified topology graph model. ONE host-keyed node/edge structure that
// carries BOTH edge types — this is the "extend the existing model, don't fork
// it" contract:
//   - 'l2_link'    : physical adjacency from LLDP/CDP (lldp_neighbors, mig 063),
//                    undirected agent↔agent.
//   - 'service_dep': observed TCP service dependency (service_dependencies,
//                    mig 066), directed src→dst on a dst_port.
//
// Nodes are monitored hosts keyed by agent id (the same key the LLDP graph and
// cross-agent clustering already use). Pure: no I/O.
//
//   buildTopologyGraph({ l2: <lldp_neighbors rows>, serviceDeps: <service_dependencies rows>, agents })
//     -> { nodes:[{id,label}], edges:[{type,...}], totals }

function buildTopologyGraph({ l2 = [], serviceDeps = [], agents = [] } = {}) {
  const labelById = new Map();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (a && a.id != null) labelById.set(Number(a.id), a.display_name || a.hostname || `agent ${a.id}`);
  }

  const nodes = new Map(); // id -> node
  const ensureNode = (id) => {
    const key = Number(id);
    let n = nodes.get(key);
    if (!n) {
      n = { id: key, label: labelById.has(key) ? labelById.get(key) : `agent ${key}` };
      nodes.set(key, n);
    }
    return n;
  };

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
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenL2.has(key)) continue;
    seenL2.add(key);
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

  const l2Count = edges.filter((e) => e.type === 'l2_link').length;
  return {
    nodes: [...nodes.values()],
    edges,
    totals: { nodes: nodes.size, l2_link: l2Count, service_dep: edges.length - l2Count },
  };
}

module.exports = { buildTopologyGraph };
