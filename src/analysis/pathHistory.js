'use strict';

// The history of one traced path: every run kept as its own record, what
// changed between two of them, and where the route moved.
//
// The path graph (src/analysis/pathGraph.js) answers "what does this path look
// like", by taking the median over the last N runs. That is the right answer
// for "is it healthy now" and the wrong one for "why was it slow on Tuesday":
// the median is exactly what hides a single bad run, and a route that changed
// and changed back leaves no trace in it at all.
//
// So this module keeps the runs apart:
//   summarise(run)          one row for the run list
//   routeKey(hops)          the ordered responding addresses — the identity of
//                           a route, so two runs can be called the same or not
//   withRouteChanges(runs)  marks each run that took a different route from the
//                           run before it (oldest first is the order that means
//                           anything: a change belongs to the newer run)
//   diffRuns(before, after) hop-by-hop, aligned so an inserted hop reads as one
//                           inserted hop rather than as every hop after it
//                           having changed

const MAX_HOPS = 64;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// The hops that answered, in order. A silent hop is not part of a route's
// identity: a router that declines to send ICMP today and does tomorrow has not
// rerouted anything, and counting it would cry "route changed" on every run.
function respondingHops(hops) {
  return (Array.isArray(hops) ? hops : [])
    .filter((h) => h && h.ip && h.rttMs != null && Number.isInteger(Number(h.hop)))
    .map((h) => ({ hop: Number(h.hop), ip: String(h.ip), rttMs: num(h.rttMs), lossPct: num(h.lossPct), hostname: h.hostname || null }))
    .sort((a, b) => a.hop - b.hop)
    .slice(0, MAX_HOPS);
}

// The identity of a route: the addresses that answered, in order. Two runs with
// the same key went the same way.
function routeKey(hops) {
  return respondingHops(hops).map((h) => h.ip).join('>');
}

// One row of the run list. No hops — the list is read far more often than any
// one run is opened, and the hop array is the bulk of the record.
function summarise(run) {
  const hops = Array.isArray(run && run.hops) ? run.hops : [];
  const responding = respondingHops(hops);
  const last = responding.length ? responding[responding.length - 1] : null;
  return {
    id: run.id,
    ts: run.ts,
    agentId: run.agentId ?? null,
    type: run.type,
    target: run.target,
    ok: !!run.ok,
    // What the operator scans the list for.
    hopCount: hops.length,
    respondingCount: responding.length,
    silentCount: hops.length - responding.length,
    // End-to-end: the last hop that answered is the closest thing a traceroute
    // has to "the destination replied in N ms". Null when nothing answered.
    rttMs: num(run.rttMs) ?? (last ? last.rttMs : null),
    lossPct: num(run.lossPct),
    // Why an empty run was empty (agent's own words).
    detail: run.detail ?? null,
    routeKey: routeKey(hops),
  };
}

// Marks each run that took a different route from the one before it. `runs` are
// summaries or full runs in ANY order; the result is newest-first, which is how
// a list is read, with `routeChanged` set from the run that preceded it in TIME.
//
// The oldest run in the window is never a change: there is nothing before it to
// have changed from, and calling it one would put a false "route changed" at
// the bottom of every list.
function withRouteChanges(runs) {
  const rows = (Array.isArray(runs) ? runs : [])
    .map((r) => (r && r.routeKey !== undefined ? r : summarise(r)))
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  let prev = null;
  for (const r of rows) {
    // A run with nothing to compare (it failed, or nothing answered) neither
    // is a change nor hides one: it is skipped, and the next run is compared
    // with the last run that actually traced something.
    if (!r.routeKey) { r.routeChanged = false; continue; }
    r.routeChanged = prev !== null && prev !== r.routeKey;
    prev = r.routeKey;
  }
  return rows.reverse();
}

// Longest common subsequence over two address sequences, as index pairs. Plain
// dynamic programming: a traceroute is at most 64 hops, so the table is tiny.
function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

// Two runs, hop by hop.
//
// ALIGNED, NOT ZIPPED. Comparing hop 4 with hop 4 reads an inserted hop as
// "every hop from 4 onwards changed", which is the opposite of the truth and
// the reason a reader cannot find the one thing that actually moved. The
// responding addresses are aligned by their longest common subsequence, so an
// inserted hop is one `added` row and everything else stays `same`.
//
//   diffRuns(before, after) -> {
//     routeChanged, addedCount, removedCount,
//     rttBeforeMs, rttAfterMs, rttDeltaMs,
//     rows: [{ kind: 'same'|'added'|'removed', ip, hostname,
//              beforeHop, afterHop, beforeRttMs, afterRttMs, deltaMs }]
//   }
//
// `deltaMs` on a `same` row is how much longer that hop took in `after`. It is
// the number the reader is looking for: the hop where the extra time appeared.
function diffRuns(before, after) {
  const a = respondingHops(before && before.hops);
  const b = respondingHops(after && after.hops);
  const pairs = lcs(a.map((h) => h.ip), b.map((h) => h.ip));

  const rows = [];
  let i = 0;
  let j = 0;
  const removed = (h) => rows.push({ kind: 'removed', ip: h.ip, hostname: h.hostname, beforeHop: h.hop, afterHop: null, beforeRttMs: h.rttMs, afterRttMs: null, deltaMs: null });
  const added = (h) => rows.push({ kind: 'added', ip: h.ip, hostname: h.hostname, beforeHop: null, afterHop: h.hop, beforeRttMs: null, afterRttMs: h.rttMs, deltaMs: null });
  const flush = (untilA, untilB) => {
    while (i < untilA) { removed(a[i]); i += 1; }
    while (j < untilB) { added(b[j]); j += 1; }
  };
  for (const [ai, bj] of pairs) {
    flush(ai, bj);
    const x = a[i];
    const y = b[j];
    rows.push({
      kind: 'same',
      ip: y.ip,
      hostname: y.hostname || x.hostname,
      beforeHop: x.hop,
      afterHop: y.hop,
      beforeRttMs: x.rttMs,
      afterRttMs: y.rttMs,
      deltaMs: (x.rttMs != null && y.rttMs != null) ? num(y.rttMs - x.rttMs) : null,
    });
    i += 1;
    j += 1;
  }
  flush(a.length, b.length);

  const endRtt = (list) => (list.length ? list[list.length - 1].rttMs : null);
  const rttBeforeMs = num(before && before.rttMs) ?? endRtt(a);
  const rttAfterMs = num(after && after.rttMs) ?? endRtt(b);
  return {
    routeChanged: routeKey(before && before.hops) !== routeKey(after && after.hops),
    addedCount: rows.filter((r) => r.kind === 'added').length,
    removedCount: rows.filter((r) => r.kind === 'removed').length,
    rttBeforeMs,
    rttAfterMs,
    rttDeltaMs: (rttBeforeMs != null && rttAfterMs != null) ? num(rttAfterMs - rttBeforeMs) : null,
    // The hop where the most time appeared, when one stands out. This is the
    // answer to "it got slower — where?", and computing it here means every
    // reader gets the same answer.
    worstDelta: rows.filter((r) => r.kind === 'same' && r.deltaMs != null)
      .reduce((w, r) => (w === null || r.deltaMs > w.deltaMs ? r : w), null),
    rows,
  };
}

module.exports = { summarise, routeKey, withRouteChanges, diffRuns, respondingHops };
