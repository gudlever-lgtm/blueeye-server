'use strict';

// Blast radius: given a failing node (an agent id), compute which downstream
// hosts and services are affected, from the unified topology graph
// (buildTopologyGraph output — typed `l2_link` + `service_dep` edges).
//
// Two tiers, each with the path that justifies it:
//   1. directly_isolated  — hosts that lose L2 connectivity when the node fails.
//      `l2_link` is UNDIRECTED (LLDP adjacency is symmetric), so "downstream"
//      here means the failing node's L2-reachable neighbourhood within the depth
//      cap — the hosts cut off with/behind it.
//   2. dependency_affected — hosts that DEPEND on an isolated/failing host, found
//      by walking `service_dep` edges in REVERSE (a `service_dep` edge is
//      source→target meaning "source depends on target", so the dependents of X
//      are the sources of edges whose target is X). Transitive up to the cap.
//
// Pure, no I/O. Cycle-safe (shared `seen` sets). Depth-capped (default 4).
// Complexity: building the two adjacency indices is O(E); each BFS visits every
// node/edge at most once ⇒ O(V + E) total, O(V + E) memory.

const DEFAULT_MAX_DEPTH = 4;

function buildIndices(edges) {
  const l2 = new Map();        // node -> Set(neighbour)  (undirected)
  const depReverse = new Map(); // target -> [{ src, port }] (who depends on target)
  const addL2 = (a, b) => { if (!l2.has(a)) l2.set(a, new Set()); l2.get(a).add(b); };

  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e) continue;
    if (e.type === 'l2_link') {
      const a = Number(e.source);
      const b = Number(e.target);
      if (a === b) continue;
      addL2(a, b); addL2(b, a);
    } else if (e.type === 'service_dep') {
      const src = Number(e.source);
      const tgt = Number(e.target);
      if (src === tgt) continue;
      if (!depReverse.has(tgt)) depReverse.set(tgt, []);
      depReverse.get(tgt).push({ src, port: e.dstPort != null ? Number(e.dstPort) : null });
    }
  }
  return { l2, depReverse };
}

// Depth-capped, cycle-safe BFS. `sources` seeds the frontier at depth 0;
// `neighboursOf(node)` yields { to, port } steps. Returns a parent map for
// path reconstruction and the set of reached nodes (sources included).
function boundedBfs(sources, neighboursOf, maxDepth) {
  const seen = new Set(sources);
  const parent = new Map(); // node -> { from, port }
  let frontier = [...sources];
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    depth += 1;
    const next = [];
    for (const node of frontier) {
      for (const step of neighboursOf(node)) {
        if (seen.has(step.to)) continue; // cycle-safe / no re-visit
        seen.add(step.to);
        parent.set(step.to, { from: node, port: step.port ?? null });
        next.push(step.to);
      }
    }
    frontier = next;
  }
  return { seen, parent };
}

function computeBlastRadius(graph, failingNodeRaw, { maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  const failingNode = Number(failingNodeRaw);
  const depthCap = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : DEFAULT_MAX_DEPTH;
  const edges = (graph && graph.edges) || [];
  const { l2, depReverse } = buildIndices(edges);

  // ---- Tier 1: L2 neighbourhood (undirected) from the failing node ----------
  const t1 = boundedBfs(
    [failingNode],
    (node) => [...(l2.get(node) || [])].map((to) => ({ to, port: null })),
    depthCap,
  );
  const l2PathTo = (node) => {
    const path = [];
    let cur = node;
    // Walk parents back to the failing node.
    for (let guard = 0; cur !== undefined && guard <= depthCap + 1; guard += 1) {
      path.unshift(cur);
      if (cur === failingNode) break;
      const p = t1.parent.get(cur);
      cur = p ? p.from : undefined;
    }
    return path;
  };
  const directly_isolated = [...t1.seen]
    .filter((n) => n !== failingNode)
    .sort((a, b) => a - b)
    .map((hostId) => ({ hostId, path: l2PathTo(hostId) }));

  // ---- Tier 2: service_dep dependents of the failing + isolated set ----------
  // Seed with the failing node AND the isolated hosts: their services are down,
  // so anything depending on any of them is affected.
  const seed = t1.seen; // includes failingNode + isolated
  const t2 = boundedBfs(
    seed,
    (node) => (depReverse.get(node) || []).map((d) => ({ to: d.src, port: d.port })),
    depthCap,
  );
  const depPathTo = (node) => {
    const chain = [];
    let cur = node;
    for (let guard = 0; cur !== undefined && !seed.has(cur) && guard <= depthCap + 1; guard += 1) {
      const p = t2.parent.get(cur);
      chain.unshift({ hostId: cur, viaPort: p ? p.port : null });
      cur = p ? p.from : undefined;
    }
    if (cur !== undefined) chain.unshift({ hostId: cur, viaPort: null }); // the anchor (isolated/failing host)
    return chain;
  };
  const dependency_affected = [...t2.seen]
    .filter((n) => !seed.has(n))
    .sort((a, b) => a - b)
    .map((hostId) => ({ hostId, path: depPathTo(hostId) }));

  return {
    failingNode,
    depthCap,
    directly_isolated,
    dependency_affected,
    totals: { directly_isolated: directly_isolated.length, dependency_affected: dependency_affected.length },
  };
}

module.exports = { computeBlastRadius, DEFAULT_MAX_DEPTH };
