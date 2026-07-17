'use strict';

// Pure LLDP neighbor graph (Fase 4). Turns persisted lldp_neighbors rows into an
// agent↔agent adjacency graph and answers, for two targets (agent ids):
//   adjacent (1 hop) | within-N hops | unknown
//
// Two agents are ADJACENT when:
//   (a) direct link — one reports the other's chassis as its remote neighbor
//       (remote_chassis_id === the other agent's local_chassis_id), OR
//   (b) shared segment — both report the SAME remote chassis (e.g. two hosts
//       plugged into one switch that isn't itself a monitored agent).
// Longer relations are BFS over that agent-projected graph.
//
// Graceful degradation (the whole point): an agent with no LLDP rows — or a pair
// with no path — is UNKNOWN, never "not adjacent". Missing data must never let
// clustering assert two targets are unrelated.
//
//   const g = buildLldpGraph(rows);
//   g.relation('3', '4');            // -> { relation:'adjacent', hops:1, detail:'…' }
//   g.relation('3', '9', { maxHops: 3 });

const DEFAULT_MAX_HOPS = 2;

function buildLldpGraph(rows) {
  const edges = new Map();          // agentId -> Set(adjacent agentId)
  const chassisToAgent = new Map(); // local_chassis_id -> agentId
  const present = new Set();        // agents that reported at least one row
  const chassisLabel = new Map();   // agentId -> its chassis id (for evidence text)

  const list = Array.isArray(rows) ? rows : [];
  for (const r of list) {
    if (!r || r.localAgentId == null) continue;
    const a = String(r.localAgentId);
    present.add(a);
    if (r.localChassisId) { chassisToAgent.set(String(r.localChassisId), a); chassisLabel.set(a, String(r.localChassisId)); }
  }

  const link = (a, b) => {
    if (a === b) return;
    if (!edges.has(a)) edges.set(a, new Set());
    if (!edges.has(b)) edges.set(b, new Set());
    edges.get(a).add(b);
    edges.get(b).add(a);
  };

  // (a) direct links + (b) shared-segment links.
  const bySharedChassis = new Map(); // remote_chassis_id -> Set(agent)
  for (const r of list) {
    if (!r || r.localAgentId == null || !r.remoteChassisId) continue;
    const a = String(r.localAgentId);
    const remote = String(r.remoteChassisId);
    const asAgent = chassisToAgent.get(remote);
    if (asAgent) link(a, asAgent);                 // (a) direct: remote chassis is another agent
    if (!bySharedChassis.has(remote)) bySharedChassis.set(remote, new Set());
    bySharedChassis.get(remote).add(a);
  }
  for (const agents of bySharedChassis.values()) {  // (b) shared segment
    const arr = [...agents];
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) link(arr[i], arr[j]);
    }
  }

  // Shortest hop count between two agents (BFS), or Infinity if unreachable.
  function hopsBetween(a, b) {
    if (a === b) return 0;
    if (!edges.has(a) || !edges.has(b)) return Infinity;
    const seen = new Set([a]);
    let frontier = [a];
    let depth = 0;
    while (frontier.length) {
      depth += 1;
      const next = [];
      for (const node of frontier) {
        for (const nb of edges.get(node) || []) {
          if (nb === b) return depth;
          if (!seen.has(nb)) { seen.add(nb); next.push(nb); }
        }
      }
      frontier = next;
    }
    return Infinity;
  }

  function label(agentId) {
    return chassisLabel.has(agentId) ? chassisLabel.get(agentId) : `agent ${agentId}`;
  }

  // relation(a, b): 'adjacent' | 'within-N' | 'unknown' + hop count + a short,
  // explainable detail naming the two devices. maxHops bounds "related".
  function relation(aRaw, bRaw, { maxHops = DEFAULT_MAX_HOPS } = {}) {
    const a = String(aRaw);
    const b = String(bRaw);
    // A target with NO LLDP presence is unknown, not "unrelated".
    if (!present.has(a) || !present.has(b)) return { relation: 'unknown', hops: null, detail: null, related: false };
    const hops = hopsBetween(a, b);
    if (hops === Infinity || hops > maxHops) return { relation: 'unknown', hops: null, detail: null, related: false };
    if (hops === 1) return { relation: 'adjacent', hops: 1, related: true, detail: `LLDP: ${label(a)} adjacent to ${label(b)}` };
    return { relation: 'within-N', hops, related: true, detail: `LLDP: ${label(a)} within ${hops} hops of ${label(b)}` };
  }

  return { relation, hopsBetween, present, size: edges.size };
}

module.exports = { buildLldpGraph, DEFAULT_MAX_HOPS };
