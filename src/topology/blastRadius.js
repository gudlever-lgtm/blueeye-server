'use strict';

// Blast radius: given a failing node, compute which downstream hosts and
// services are affected, from the unified topology graph (buildTopologyGraph
// output — typed `l2_link` + `service_dep` edges).
//
// THE FAILING NODE MAY BE A SWITCH. It used to be "an agent id", and every id
// here went through `Number()` — which quietly turned a switch's `d:5` into
// NaN, so asking what a switch cut off returned nothing at all and said
// nothing about why. The graph carries both kinds of node now
// (src/topology/nodeId.js), and this walks them the same way: an LLDP
// adjacency is an LLDP adjacency whether the thing reporting it is an agent or
// a switch, and a switch going down is the case this whole tier exists for.
//
// Ids are compared as STRINGS throughout (`nodeKey`). A Map keyed on raw ids
// would hold 5 and '5' as two entries, and an id arriving from a URL or from
// JSON is a string — that is a node silently failing to match itself.
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
// WHAT IS KNOWN TO BE UP IS NOT CUT OFF. `l2_link` is undirected, so the bare
// walk from a failing agent reaches its access switch and, through it, every
// other host on that switch — all "isolated" by a host that is a leaf. That is
// how an agent whose service stopped used to grey out every healthy neighbour
// on the troubleshooting map. A caller that knows which nodes are alive (an
// agent that is online and reporting, a switch whose last poll answered)
// passes `isAlive(id)`: such a node is reachable by definition, so it is never
// listed as isolated and the walk does not continue THROUGH it — whatever is
// behind a node we can hear is not cut off by the failing one. The nodes the
// walk stopped at are returned as `known_reachable` so the answer says why it
// is smaller. Without `isAlive` the walk is the plain what-if it always was
// ("if this node died, what could it take with it"), which is what the
// /api/topology/blast-radius endpoint asks.
//
// Pure, no I/O. Cycle-safe (shared `seen` sets). Depth-capped (default 4).
// Complexity: building the two adjacency indices is O(E); each BFS visits every
// node/edge at most once ⇒ O(V + E) total, O(V + E) memory.

const { key: nodeKey, compare: compareNodes, parse: parseNodeId } = require('./nodeId');

const DEFAULT_MAX_DEPTH = 4;

function buildIndices(edges) {
  const l2 = new Map();        // node -> Set(neighbour)  (undirected)
  const depReverse = new Map(); // target -> [{ src, port }] (who depends on target)
  const addL2 = (a, b) => { if (!l2.has(a)) l2.set(a, new Set()); l2.get(a).add(b); };

  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e) continue;
    if (e.type === 'l2_link') {
      const a = nodeKey(e.source);
      const b = nodeKey(e.target);
      if (!a || !b || a === b) continue;
      addL2(a, b); addL2(b, a);
    } else if (e.type === 'service_dep') {
      const src = nodeKey(e.source);
      const tgt = nodeKey(e.target);
      if (!src || !tgt || src === tgt) continue;
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

function computeBlastRadius(graph, failingNodeRaw, { maxDepth = DEFAULT_MAX_DEPTH, isAlive = null } = {}) {
  // The id as the graph spells it — `12` for an agent, `d:5` for a switch —
  // and the string form everything below compares on.
  const failingNode = parseNodeId(failingNodeRaw) ?? failingNodeRaw;
  const failingKey = nodeKey(failingNode);
  const depthCap = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : DEFAULT_MAX_DEPTH;
  const edges = (graph && graph.edges) || [];
  const { l2, depReverse } = buildIndices(edges);

  // The walk is over string keys; what comes BACK out is the id the graph
  // carries, so a caller gets `12` for an agent and `d:5` for a switch rather
  // than the internal spelling of either.
  const idByKey = new Map();
  for (const n of (graph && graph.nodes) || []) {
    if (n && n.id != null) idByKey.set(nodeKey(n.id), n.id);
  }
  // `parseNodeId` already refuses everything that is not an id — and refuses
  // it properly: `Number('')` and `Number(null)` are both 0, which is how a
  // missing node would come back as node zero.
  const idOf = (k) => (idByKey.has(k) ? idByKey.get(k) : (parseNodeId(k) ?? k));

  // A node that is heard from is not cut off (see the header). A predicate that
  // throws is treated as "not known alive", which is the pre-fix behaviour.
  const alive = (k) => {
    if (typeof isAlive !== 'function' || k === failingKey) return false;
    try { return Boolean(isAlive(idOf(k))); } catch { return false; }
  };
  const reachable = new Set();

  // ---- Tier 1: L2 neighbourhood (undirected) from the failing node ----------
  const t1 = boundedBfs(
    [failingKey],
    (node) => [...(l2.get(node) || [])]
      .filter((to) => {
        if (!alive(to)) return true;
        reachable.add(to);
        return false;
      })
      .map((to) => ({ to, port: null })),
    depthCap,
  );
  const l2PathTo = (node) => {
    const path = [];
    let cur = node;
    // Walk parents back to the failing node.
    for (let guard = 0; cur !== undefined && guard <= depthCap + 1; guard += 1) {
      path.unshift(idOf(cur));
      if (cur === failingKey) break;
      const p = t1.parent.get(cur);
      cur = p ? p.from : undefined;
    }
    return path;
  };
  const directly_isolated = [...t1.seen]
    .filter((n) => n !== failingKey)
    .map(idOf)
    .sort(compareNodes)
    .map((hostId) => ({ hostId, path: l2PathTo(nodeKey(hostId)) }));

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
      chain.unshift({ hostId: idOf(cur), viaPort: p ? p.port : null });
      cur = p ? p.from : undefined;
    }
    if (cur !== undefined) chain.unshift({ hostId: idOf(cur), viaPort: null }); // the anchor (isolated/failing host)
    return chain;
  };
  const dependency_affected = [...t2.seen]
    .filter((n) => !seed.has(n))
    .map(idOf)
    .sort(compareNodes)
    .map((hostId) => ({ hostId, path: depPathTo(nodeKey(hostId)) }));

  return {
    failingNode,
    depthCap,
    directly_isolated,
    dependency_affected,
    // Neighbours the L2 walk stopped at because they are known to be up. Empty
    // when no `isAlive` was given.
    known_reachable: [...reachable].map(idOf).sort(compareNodes),
    totals: { directly_isolated: directly_isolated.length, dependency_affected: dependency_affected.length },
  };
}

module.exports = { computeBlastRadius, DEFAULT_MAX_DEPTH };
