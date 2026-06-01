'use strict';

// Root-cause hinting. Groups findings that fired close together in time on the
// same host into a single "incident", and uses a CONFIGURABLE dependency graph
// (src/analysis/dependency-graph.json — never hardcoded here) to pick the most
// likely upstream cause among them. Everything stays local and explainable: no
// ML, just time clustering + a directed graph walk, with a Danish hint.
//
//   const correlator = createCorrelator();                 // ships the default graph
//   const correlator = createCorrelator({ graph });        // inject your own (tests)
//   const groups = correlator.correlate(findings, 60000);
//   // -> [{ findings:[...], likelyCause: Finding, hint: string }, ...]

const DEFAULT_WINDOW_MS = 60000;

// Loads the shipped dependency graph. Falls back to an empty graph (pure
// time-clustering, earliest = cause) if the file is missing or unreadable.
function loadDefaultGraph() {
  try {
    // eslint-disable-next-line global-require
    return require('./dependency-graph.json');
  } catch {
    return {};
  }
}

// Indexes a cause->effects graph for ancestry queries. Cycle-safe: descendants
// are memoised and the cache entry is seeded before recursing, so a cycle just
// terminates instead of looping forever. Keys beginning with "_" are treated as
// documentation and ignored.
function indexGraph(graph) {
  const adj = new Map(); // node -> Set(direct effects)
  const ensure = (n) => {
    if (!adj.has(n)) adj.set(n, new Set());
    return adj.get(n);
  };

  if (graph && typeof graph === 'object') {
    for (const [cause, effects] of Object.entries(graph)) {
      if (cause.startsWith('_')) continue; // documentation key
      const set = ensure(cause);
      if (Array.isArray(effects)) {
        for (const e of effects) {
          set.add(e);
          ensure(e);
        }
      }
    }
  }

  const cache = new Map();
  function descendants(node) {
    if (cache.has(node)) return cache.get(node);
    const out = new Set();
    cache.set(node, out); // seed before recursing so cycles terminate
    const direct = adj.get(node);
    if (direct) {
      for (const e of direct) {
        out.add(e);
        for (const d of descendants(e)) out.add(d);
      }
    }
    return out;
  }

  return {
    // True when `a` is a (transitive) upstream cause of `b`.
    isAncestor(a, b) {
      return a !== b && descendants(a).has(b);
    },
  };
}

// Milliseconds for a finding, tolerant of Date or ISO string. Findings without a
// usable createdAt sort to the front (treated as epoch) rather than blowing up.
function toTime(finding) {
  const t = finding && finding.createdAt ? new Date(finding.createdAt).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function createCorrelator({ graph } = {}) {
  const idx = indexGraph(graph || loadDefaultGraph());

  // Likely cause of a cluster: the finding that nothing else in the cluster is
  // upstream of (a "root" within the cluster), breaking ties by earliest time.
  // This makes the dependency graph the primary signal and time the fallback —
  // an upstream metric wins even if a downstream symptom was logged first.
  function pickLikelyCause(cluster) {
    const roots = cluster.filter(
      (f) => !cluster.some((g) => g !== f && idx.isAncestor(g.metric, f.metric)),
    );
    const pool = roots.length ? roots : cluster; // cycle fallback: whole cluster
    return pool.reduce((best, f) => (toTime(f) < toTime(best) ? f : best), pool[0]);
  }

  // Danish, explainable hint that always names the real metrics involved.
  function buildHint(cluster, likely) {
    const others = [...new Set(cluster.filter((f) => f !== likely).map((f) => f.metric))];

    if (others.length === 0) {
      return (
        `Enkeltstående ${likely.severity || ''}-finding på ${likely.metric} ` +
        'uden korrelerede findings inden for vinduet.'
      ).replace(/\s+/g, ' ').trim();
    }

    const downstream = others.filter((m) => idx.isAncestor(likely.metric, m));
    if (downstream.length) {
      return (
        `Sandsynlig rodårsag: ${likely.metric} (${likely.severity}). ` +
        `Korrelerede følgefejl: ${others.join(', ')}. ` +
        `${likely.metric} ligger opstrøms for ${downstream.join(', ')} i ` +
        `afhængighedsgrafen — undersøg ${likely.metric} først.`
      );
    }

    return (
      `${cluster.length} samtidige findings på host ${likely.hostId}: ` +
      `${[likely.metric, ...others].join(', ')}. ` +
      `Tidligst observeret: ${likely.metric} — start undersøgelsen der.`
    );
  }

  // Groups findings into time clusters per host and annotates each group with a
  // likely cause and a hint. Mutates each correlated finding's `correlatedWith`
  // (the ids of the other findings in its cluster) so the caller can persist the
  // links. A cluster spans at most `windowMs` from its earliest member.
  function correlate(findings, windowMs = DEFAULT_WINDOW_MS) {
    if (!Array.isArray(findings) || findings.length === 0) return [];

    const byHost = new Map();
    for (const f of findings) {
      if (!f || !f.metric) continue;
      const key = f.hostId == null ? '∅' : String(f.hostId);
      if (!byHost.has(key)) byHost.set(key, []);
      byHost.get(key).push(f);
    }

    const groups = [];
    for (const list of byHost.values()) {
      const sorted = list.slice().sort((a, b) => toTime(a) - toTime(b));

      let cluster = [];
      let anchor = null; // time of the cluster's first finding

      const flush = () => {
        if (cluster.length === 0) return;
        const likely = pickLikelyCause(cluster);
        if (cluster.length > 1) {
          for (const f of cluster) {
            f.correlatedWith = cluster.filter((g) => g !== f).map((g) => g.id).filter(Boolean);
          }
        }
        groups.push({ findings: cluster, likelyCause: likely, hint: buildHint(cluster, likely) });
        cluster = [];
        anchor = null;
      };

      for (const f of sorted) {
        const t = toTime(f);
        if (anchor === null) {
          anchor = t;
          cluster.push(f);
        } else if (t - anchor <= windowMs) {
          cluster.push(f);
        } else {
          flush();
          anchor = t;
          cluster.push(f);
        }
      }
      flush();
    }

    return groups;
  }

  return { correlate };
}

module.exports = { createCorrelator, indexGraph, DEFAULT_WINDOW_MS };
