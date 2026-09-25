'use strict';

const { locateHop, settlePath } = require('../geo/hopLocation');
const { cloudOrigin } = require('../geo/hostingNetworks');

// Turns a set of traceroute probe results (repeated runs to one target) into a
// directed, weighted path graph — the model behind the dashboard's path map.
// Each TTL position becomes a node carrying aggregated per-hop metrics (latency,
// loss, jitter) and, for public addresses, GeoIP/ASN; consecutive nodes are
// joined by links weighted with the downstream loss + the incremental latency.
//
// Analysis is local + explainable (CLAUDE.md): we aggregate with the median (the
// robust centre, unmoved by a single odd run), classify against fixed thresholds,
// and attach a plain-language `explain` to every node. No ML, no cloud.
//
//   buildPathGraph(results, { geoProvider, cityProvider, centroids, target, origin })
//     results  - probe rows (type 'traceroute') for ONE target, any order
//     deps     - optional geoProvider.lookup(ip), cityProvider.lookup(ip) and
//                centroids.get(country); origin = the agent's site { lat, lng }

// Severity thresholds, shared with the fleet verdict so the colours mean the same
// thing everywhere (see public/app.js fleetKpis): loss% / jitter ms / latency ms.
const T = {
  loss: { warn: 2, bad: 20 },
  jitter: { warn: 30, bad: 100 },
  latency: { warn: 120, bad: 250 },
};

// Severity order, shared. `muted` sits BELOW `ok` because it is not a degree of
// badness at all — it means NOT MEASURED (a silent router that never answers
// ICMP, which is normal). Ranking it above `ok` turns the most ordinary path
// there is into a warning.
//
// The dashboard keeps its own copy (public/views/destinations.js RANK): it is
// vanilla browser JS with no build step, so it cannot import this. The copies
// are pinned to each other by test/pathSeverityRank.test.js — they drifted
// once, and the screen then called a silent router the worst hop under a
// sentence reading "(silent router — normal)".
const SEVERITY_RANK = Object.freeze({ bad: 3, warn: 2, ok: 1, muted: 0 });
// The floor for naming a worst hop. Below it there is no worst hop at all.
const WORST_MIN_RANK = SEVERITY_RANK.warn;

function median(xs) {
  const a = xs.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const round = (n) => (n == null ? null : Math.round(n * 100) / 100);

// Worst of the three metric verdicts → the node's colour. A hop that never
// answered across every run is a silent router (routers commonly don't emit
// ICMP "TTL exceeded"); that's normal, so it's 'muted', not a fault.
function classify({ lossPct, jitterMs, rttMs, responded, unresponsive }) {
  if (unresponsive) return { severity: 'muted', reason: 'No ICMP reply (silent router — normal)' };
  const reasons = [];
  let rank = 0;
  const bump = (level, why) => { rank = Math.max(rank, level); if (level > 0) reasons.push(why); };
  if (lossPct != null) bump(lossPct >= T.loss.bad ? 2 : lossPct >= T.loss.warn ? 1 : 0, `${round(lossPct)}% loss`);
  if (jitterMs != null) bump(jitterMs >= T.jitter.bad ? 2 : jitterMs >= T.jitter.warn ? 1 : 0, `${round(jitterMs)} ms jitter`);
  if (rttMs != null) bump(rttMs >= T.latency.bad ? 2 : rttMs >= T.latency.warn ? 1 : 0, `${round(rttMs)} ms latency`);
  const severity = rank === 2 ? 'bad' : rank === 1 ? 'warn' : 'ok';
  const reason = reasons.length ? reasons.join(' · ') : (responded ? 'Healthy' : 'No data yet');
  return { severity, reason };
}

// Most frequent non-null value in a list (used to pick a hop's representative IP
// when load-balancing makes it vary run to run).
function mode(values) {
  const counts = new Map();
  let best = null;
  let bestN = 0;
  for (const v of values) {
    if (v == null) continue;
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) { bestN = n; best = v; }
  }
  return best;
}

// Where a hop goes on the map: the router's own name first, then city GeoIP,
// then the country centroid — each checked against the hop's RTT. See
// src/geo/hopLocation.js. `rttMs` is the lowest RTT seen (the tightest bound).
function enrichGeo(ip, deps = {}, { hostname = null, rttMs = null } = {}) {
  return locateHop({ ip, hostname, rttMs }, deps);
}

// The fastest reply a hop gave across runs — minMs where the agent sends it,
// else the per-run average. The speed-of-light check wants the lowest number.
function fastestOf(h) {
  const v = h.minMs != null ? h.minMs : h.rttMs;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// The probe types that produce a hop list. Both trace the same kind of path —
// `traceroute` with ICMP/UDP, `tcptraceroute` with TCP SYNs to a port — and both
// report the identical per-hop record, so one graph builder serves both. They are
// never MIXED into one graph: the caller selects a type, because a filtered
// ICMP path and a working TCP path to the same host are two different findings.
const PATH_PROBE_TYPES = Object.freeze(['traceroute', 'tcptraceroute']);

function buildPathGraph(results, { geoProvider = null, cityProvider = null, centroids = null, target = null, origin = null } = {}) {
  const runs = (Array.isArray(results) ? results : [])
    .filter((r) => r && PATH_PROBE_TYPES.includes(r.type) && Array.isArray(r.hops));
  const tsList = runs.map((r) => (r.ts ? new Date(r.ts).getTime() : null)).filter((n) => n != null);
  const meta = {
    target: target || (runs.length ? runs[runs.length - 1].target : null),
    samples: runs.length,
    firstTs: tsList.length ? new Date(Math.min(...tsList)).toISOString() : null,
    lastTs: tsList.length ? new Date(Math.max(...tsList)).toISOString() : null,
    // The newest run's diagnostic (e.g. "traceroute not installed"), so the UI can
    // explain an empty path instead of rendering a blank map. null on a clean run.
    detail: runs.length ? (runs[runs.length - 1].detail ?? null) : null,
  };
  if (!runs.length) return { ...meta, nodes: [], links: [] };

  // Bucket every hop by its TTL position across all runs. Per address, the PTR
  // name (newest run wins) and the fastest reply seen, for placing it on the map.
  const byPos = new Map();
  const names = new Map();
  const fastest = new Map();
  let maxPos = 0;
  for (const run of runs) {
    for (const h of run.hops) {
      const pos = Number(h.hop);
      if (!Number.isInteger(pos) || pos < 1) continue;
      maxPos = Math.max(maxPos, pos);
      if (!byPos.has(pos)) byPos.set(pos, { ips: [], rtt: [], loss: [], jitter: [], responded: 0, runs: 0 });
      const b = byPos.get(pos);
      b.runs += 1;
      b.ips.push(h.ip || null);
      if (h.ip && h.hostname) names.set(h.ip, h.hostname);
      const fast = fastestOf(h);
      if (h.ip && fast != null) fastest.set(h.ip, Math.min(fastest.has(h.ip) ? fastest.get(h.ip) : Infinity, fast));
      // A hop "responded" in a run if it produced an RTT. lossPct may be absent on
      // legacy single-sample hops, so fall back to 0/100 from whether it answered.
      const answered = h.rttMs != null;
      if (answered) { b.responded += 1; b.rtt.push(h.rttMs); }
      if (h.jitterMs != null) b.jitter.push(h.jitterMs);
      const loss = h.lossPct != null ? h.lossPct : (answered ? 0 : 100);
      b.loss.push(loss);
    }
  }

  // Source node = the reporting agent itself (TTL 0). Its map coordinates come
  // from the agent's configured site (locations.latitude/longitude), so the path
  // can be anchored geographically; null when the site has no coordinates.
  const originLat = origin && Number.isFinite(origin.lat) ? origin.lat : null;
  const originLng = origin && Number.isFinite(origin.lng) ? origin.lng : null;
  const geoOrigin = originLat != null && originLng != null ? { lat: originLat, lng: originLng } : null;
  const geoDeps = { geoProvider, cityProvider, centroids, origin: geoOrigin };
  const nodes = [{
    index: 0, kind: 'source', hop: 0, ip: null, label: (origin && origin.label) || 'Agent',
    country: null, asn: null, asnName: null, lat: originLat, lng: originLng,
    rttMs: 0, lossPct: 0, jitterMs: null, responded: runs.length, runs: runs.length,
    unresponsive: false, severity: 'ok', explain: 'Probe origin',
  }];

  for (let pos = 1; pos <= maxPos; pos += 1) {
    const b = byPos.get(pos);
    if (!b) continue;
    const ip = mode(b.ips);
    const unresponsive = b.responded === 0;
    const rttMs = round(median(b.rtt));
    const jitterMs = round(median(b.jitter));
    const lossPct = round(median(b.loss));
    const worstLossPct = round(b.loss.length ? Math.max(...b.loss) : null);
    const isDest = pos === maxPos;
    const geo = enrichGeo(ip, geoDeps, { hostname: names.get(ip) || null, rttMs: fastest.has(ip) ? fastest.get(ip) : null });
    const { severity, reason } = classify({ lossPct, jitterMs, rttMs, responded: b.responded, unresponsive });
    nodes.push({
      index: pos,
      kind: isDest ? 'dest' : 'hop',
      hop: pos,
      ip,
      label: ip || '* * *',
      country: geo.country,
      asn: geo.asn,
      asnName: geo.asnName,
      lat: geo.lat,
      lng: geo.lng,
      private: geo.private,
      hostname: geo.hostname,
      place: geo.place,
      geoRejected: geo.rejected,
      // 'exact' when the hop is drawn, null when it is not. A pin the reply
      // time rules out is never drawn as a guess any more (src/geo/hopLocation.js).
      placeCertainty: geo.place ? (geo.place.certainty || 'exact') : null,
      // Nothing could be placed, but the reply time still bounds it: the
      // responder is provably inside this radius of the agent.
      withinKm: Number.isFinite(geo.withinKm) ? geo.withinKm : null,
      rttMs,
      jitterMs,
      lossPct,
      worstLossPct,
      responded: b.responded,
      runs: b.runs,
      unresponsive,
      severity,
      explain: reason,
    });
  }

  // Second pass: place what GeoIP could not by the path itself — a reply only a
  // millisecond or two behind a placed hop came from the same place.
  settlePath(nodes.filter((n) => n.kind !== 'source').map((n) => ({
    hop: n.hop, rttMs: n.ip && fastest.has(n.ip) ? fastest.get(n.ip) : n.rttMs, node: n,
  })), { origin: geoOrigin });
  for (const n of nodes) if (n.kind !== 'source') n.placeCertainty = n.place ? (n.place.certainty || 'exact') : null;

  // Is the agent where its site says? A first public hop inside a cloud
  // provider, a few ms away, says it runs in that provider's data centre.
  // Not asked once the agent has its own position: that IS the answer to it.
  const originHint = origin && origin.source === 'agent'
    ? null
    : cloudOrigin(nodes, { fastestOf: (n) => (n.ip && fastest.has(n.ip) ? fastest.get(n.ip) : n.rttMs) });

  // Links between consecutive nodes: the downstream loss drives the colour, the
  // RTT delta (clamped at 0 — RTT can wobble below the previous hop) the weight.
  const links = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const prev = nodes[i - 1];
    const cur = nodes[i];
    const latencyMs = (cur.rttMs != null && prev.rttMs != null) ? round(Math.max(0, cur.rttMs - prev.rttMs)) : null;
    const { severity } = classify({
      lossPct: cur.lossPct, jitterMs: null, rttMs: null,
      responded: cur.responded, unresponsive: cur.unresponsive,
    });
    links.push({ from: prev.index, to: cur.index, lossPct: cur.lossPct, latencyMs, severity });
  }

  // Worst hop (highest-severity real node) — lets the Troubleshooting view
  // pre-highlight the failing hop. bad(3) > warn(2) > ok(1) > muted(0).
  const sevRank = SEVERITY_RANK;
  let worstHopIndex = null;
  let worstRank = 0;
  for (const n of nodes) {
    if (n.kind === 'source') continue;
    const r = sevRank[n.severity] || 0;
    if (r > worstRank && r >= WORST_MIN_RANK) { worstRank = r; worstHopIndex = n.index; }
  }

  const branches = buildBranches(runs, byPos, maxPos, { ...geoDeps, names, fastest });

  return { ...meta, worstHopIndex, nodes, links, branches, originHint };
}

// ECMP / multipath inference, from the runs already stored. Load-balancers make
// the responding IP at one TTL vary run to run — and, for agents that report
// every responder per hop (`hop.ips`), within ONE run too, when its probes were
// hashed onto different members. The linear graph above collapses that to the
// single mode IP. Here we keep
// EVERY distinct responding IP per TTL as a separate branch node, and record the
// observed hop→hop transitions across runs so the UI can fan the parallel paths
// out and rejoin them. `multipath` is true when any TTL saw more than one IP.
//
//   branches = {
//     multipath,
//     hops:  [{ hop, ips: [{ ip, asn, country, rttMs, lossPct, jitterMs,
//                            responded, runs, severity, explain, primary }] }],
//     edges: [{ fromHop, fromIp, toHop, toIp, runs }],
//   }
function buildBranches(runs, byPos, maxPos, {
  geoProvider = null, cityProvider = null, centroids = null, origin = null, names = new Map(), fastest = new Map(),
} = {}) {
  // Per (position, ip): accumulate the samples so each branch carries its own
  // aggregated metrics, exactly like the linear nodes but split by IP.
  const perPos = new Map(); // pos -> Map(ip -> { rtt:[], loss:[], jitter:[], responded, runs })
  const edgeCounts = new Map(); // "fromHop|fromIp|toHop|toIp" -> count
  let multipath = false;

  for (const run of runs) {
    // Ordered, responding hops in this run (skip silent/no-IP hops so branches
    // stay connected across a silent router). Each step is the SET of members
    // that answered at that TTL in this run — one address for a plain hop, two
    // or more when the probes of one run were spread over an ECMP group.
    const seq = [];
    for (const h of run.hops) {
      const pos = Number(h.hop);
      if (!Number.isInteger(pos) || pos < 1) continue;
      const ip = h.ip || null;
      if (ip == null || h.rttMs == null) continue; // only responding hops branch
      if (!perPos.has(pos)) perPos.set(pos, new Map());
      const ipMap = perPos.get(pos);
      const members = hopMembers(h);
      for (const m of members) {
        if (!ipMap.has(m)) ipMap.set(m, { rtt: [], loss: [], jitter: [], responded: 0, runs: 0 });
        const b = ipMap.get(m);
        b.runs += 1;
        b.responded += 1;
        // The hop's latency/loss/jitter are aggregates over ALL its probes, and
        // the agent does not split them per member. They are attributed to the
        // representative address only; another member counts as having answered
        // but carries no number it did not produce.
        if (m !== ip) continue;
        b.rtt.push(h.rttMs);
        if (h.jitterMs != null) b.jitter.push(h.jitterMs);
        b.loss.push(h.lossPct != null ? h.lossPct : 0);
      }
      seq.push({ pos, ips: members });
    }
    // Consecutive responding hops become directed transitions (the branch
    // edges). Within one run the agent cannot say which member led to which, so
    // every member of one step is joined to every member of the next — which is
    // exactly the fan-out/rejoin an ECMP group draws.
    for (let i = 1; i < seq.length; i += 1) {
      for (const aIp of seq[i - 1].ips) {
        for (const bIp of seq[i].ips) {
          const key = `${seq[i - 1].pos}|${aIp}|${seq[i].pos}|${bIp}`;
          edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
        }
      }
    }
  }

  const hops = [];
  for (let pos = 1; pos <= maxPos; pos += 1) {
    const ipMap = perPos.get(pos);
    if (!ipMap || ipMap.size === 0) continue;
    if (ipMap.size > 1) multipath = true;
    // Most-frequent IP at this position is the "primary" (matches the linear node).
    const primaryIp = mode((byPos.get(pos) || { ips: [] }).ips);
    const ips = [];
    for (const [ip, b] of ipMap) {
      const rttMs = round(median(b.rtt));
      const jitterMs = round(median(b.jitter));
      const lossPct = round(median(b.loss));
      const geo = enrichGeo(ip, { geoProvider, cityProvider, centroids, origin }, { hostname: names.get(ip) || null, rttMs: fastest.has(ip) ? fastest.get(ip) : null });
      const { severity, reason } = classify({ lossPct, jitterMs, rttMs, responded: b.responded, unresponsive: false });
      ips.push({
        ip, asn: geo.asn, asnName: geo.asnName, country: geo.country, private: geo.private,
        lat: geo.lat, lng: geo.lng, hostname: geo.hostname, place: geo.place,
        rttMs, jitterMs, lossPct, responded: b.responded, runs: b.runs,
        severity, explain: reason, primary: ip === primaryIp,
      });
    }
    // Primary first, then by descending run count (the strongest branches lead).
    ips.sort((x, y) => (Number(y.primary) - Number(x.primary)) || (y.runs - x.runs));
    hops.push({ hop: pos, ips });
  }

  const edges = [];
  for (const [key, count] of edgeCounts) {
    const [fromHop, fromIp, toHop, toIp] = key.split('|');
    edges.push({ fromHop: Number(fromHop), fromIp, toHop: Number(toHop), toIp, runs: count });
  }

  return { multipath, hops, edges };
}

// Every address that answered at one hop in one run: `ips` from agents that
// report it (all distinct responders at that TTL, first == ip), else just the
// hop's own `ip`. Empty for a silent hop.
function hopMembers(h) {
  const out = [];
  if (h && h.ip) out.push(String(h.ip));
  for (const ip of (h && Array.isArray(h.ips) ? h.ips : [])) {
    if (ip && !out.includes(String(ip))) out.push(String(ip));
  }
  return out;
}

// A member must have answered in at least this many earlier runs before its
// absence means anything. One sighting is a one-off reroute, not a member.
const ECMP_MIN_SIGHTINGS = 2;
// "More loss than usual": the newest run's end-to-end loss, or its worst hop
// loss, must exceed the median of the earlier runs by at least this many
// percentage points — or the newest run must have more silent hops than the
// earlier runs' median.
const ECMP_LOSS_RISE_PCT = 5;

const lossOf = (r) => (r && typeof r.lossPct === 'number' && Number.isFinite(r.lossPct) ? r.lossPct : null);
const worstHopLoss = (r) => {
  const xs = (r && Array.isArray(r.hops) ? r.hops : []).map((h) => h && h.lossPct).filter((v) => typeof v === 'number' && Number.isFinite(v));
  return xs.length ? Math.max(...xs) : null;
};
const silentHops = (r) => (r && Array.isArray(r.hops) ? r.hops : []).filter((h) => h && (h.ip == null || h.rttMs == null)).length;

// ECMP members per hop, from one run and the runs before it — the question the
// diagnose rules ask ("is there more than one path, and has one of them died?").
//
//   ecmpAnalysis(runs, { latest })
//     runs    earlier runs of the SAME probe type to the SAME target (any order;
//             `latest` itself may be among them and is then ignored)
//     latest  the run being judged (the diagnose test's own result)
//
//   → { branchCount, hops: [{ hop, ips, currentIps }], lostMembers: [...] ,
//       runsCompared }
//
// `branchCount` is the widest hop: the distinct members seen at one TTL, across
// the newest run's own `ips` AND the earlier runs. Counting inside one run alone
// was always 1 for an agent that reported one address per hop — so ECMP was
// "ruled out" on every path, including the ones that had it.
//
// A LOST MEMBER is a hop that answered from N distinct addresses in the earlier
// runs (each seen at least ECMP_MIN_SIGHTINGS times) and now answers from fewer,
// while the newest run also shows more loss or more silent hops than usual. Both
// halves are required: a member that simply was not hashed to this time is
// normal, and loss with every member present is a different fault. The evidence
// is the missing address itself, plus the before/after numbers.
//
// LIMITS, stated so nobody reads more into it: a trace that sends fewer probes
// per hop than there are members cannot see them all (so a hop is only judged
// when it was probed at least N times, where the agent says how many), and a
// Paris-style trace pins one flow to one member by design and never shows the
// others.
function ecmpAnalysis(runs, { latest = null } = {}) {
  const earlier = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r !== latest && Array.isArray(r.hops) && (latest == null || latest.id == null || r.id !== latest.id));
  const hist = new Map(); // pos -> Map(ip -> sightings)
  for (const r of earlier) {
    for (const h of r.hops) {
      const pos = Number(h && h.hop);
      if (!Number.isInteger(pos) || pos < 1 || h.rttMs == null) continue;
      if (!hist.has(pos)) hist.set(pos, new Map());
      const m = hist.get(pos);
      for (const ip of hopMembers(h)) m.set(ip, (m.get(ip) || 0) + 1);
    }
  }
  const cur = new Map(); // pos -> { ips:Set, sent }
  for (const h of (latest && Array.isArray(latest.hops) ? latest.hops : [])) {
    const pos = Number(h && h.hop);
    if (!Number.isInteger(pos) || pos < 1) continue;
    const ips = h.rttMs == null ? [] : hopMembers(h);
    cur.set(pos, { ips: new Set(ips), sent: Number.isInteger(h.sent) ? h.sent : null });
  }

  const positions = [...new Set([...hist.keys(), ...cur.keys()])].sort((a, b) => a - b);
  const hops = [];
  let branchCount = null;
  for (const pos of positions) {
    const all = new Set([...(hist.get(pos) || new Map()).keys(), ...((cur.get(pos) || {}).ips || [])]);
    if (all.size === 0) continue;
    branchCount = Math.max(branchCount || 0, all.size);
    hops.push({ hop: pos, ips: [...all], currentIps: [...((cur.get(pos) || {}).ips || [])] });
  }

  const lostMembers = [];
  if (latest && earlier.length) {
    const med = (xs) => {
      const a = xs.filter((v) => v != null).sort((x, y) => x - y);
      if (!a.length) return null;
      return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
    };
    const lossBefore = med(earlier.map(lossOf));
    const hopLossBefore = med(earlier.map(worstHopLoss));
    const silentBefore = med(earlier.map(silentHops));
    const lossNow = lossOf(latest);
    const hopLossNow = worstHopLoss(latest);
    const silentNow = silentHops(latest);
    const worse = (lossNow != null && lossBefore != null && lossNow - lossBefore >= ECMP_LOSS_RISE_PCT)
      || (hopLossNow != null && hopLossBefore != null && hopLossNow - hopLossBefore >= ECMP_LOSS_RISE_PCT)
      || (silentBefore != null && silentNow > silentBefore);
    if (worse) {
      for (const [pos, seen] of hist) {
        const members = [...seen].filter(([, n]) => n >= ECMP_MIN_SIGHTINGS).map(([ip]) => ip);
        if (members.length < 2) continue;
        const now = cur.get(pos);
        if (!now || now.ips.size === 0) continue; // a silent hop proves nothing either way
        if (now.sent != null && now.sent < members.length) continue; // too few probes to see them all
        const missing = members.filter((ip) => !now.ips.has(ip));
        if (missing.length === 0 || missing.length === members.length) continue; // none gone, or the whole hop changed
        lostMembers.push({
          hop: pos,
          missingIps: missing,
          previousIps: members,
          currentIps: [...now.ips],
          lossBefore, lossNow, worstHopLossBefore: hopLossBefore, worstHopLossNow: hopLossNow,
          silentHopsBefore: silentBefore, silentHopsNow: silentNow,
          explain: `Hop ${pos} answered from ${members.length} addresses (${members.join(', ')}) across ${earlier.length} earlier run(s) and now only from ${now.ips.size} — ${missing.join(', ')} is missing, while ${describeWorse({ lossBefore, lossNow, hopLossBefore, hopLossNow, silentBefore, silentNow })}.`,
        });
      }
    }
  }
  lostMembers.sort((a, b) => a.hop - b.hop);
  return { branchCount, hops, lostMembers, runsCompared: earlier.length };
}

function describeWorse({ lossBefore, lossNow, hopLossBefore, hopLossNow, silentBefore, silentNow }) {
  const bits = [];
  if (lossNow != null && lossBefore != null && lossNow - lossBefore >= ECMP_LOSS_RISE_PCT) bits.push(`end-to-end loss rose from ${round(lossBefore)}% to ${round(lossNow)}%`);
  if (hopLossNow != null && hopLossBefore != null && hopLossNow - hopLossBefore >= ECMP_LOSS_RISE_PCT) bits.push(`the worst hop loss rose from ${round(hopLossBefore)}% to ${round(hopLossNow)}%`);
  if (silentBefore != null && silentNow > silentBefore) bits.push(`${silentNow} hop(s) timed out (usually ${round(silentBefore)})`);
  return bits.join(' and ');
}

// One hop from a trace that is STILL RUNNING, shaped like a graph node so the
// dashboard can draw it with the same code as a finished path. Single run, so
// no medians: the numbers are the hop's own. Geo follows the same rule as the
// graph — public addresses only, the same name → city → country order and the
// same speed-of-light check (origin = the agent's site, when known).
function describeLiveHop(h, { geoProvider = null, cityProvider = null, centroids = null, origin = null } = {}) {
  const hop = Number(h && h.hop);
  if (!Number.isInteger(hop) || hop < 1 || hop > 64) return null;
  const ip = typeof h.ip === 'string' && h.ip.length <= 64 ? h.ip : null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? round(v) : null);
  const rttMs = num(h.rttMs);
  const jitterMs = num(h.jitterMs);
  const lossPct = h.lossPct != null ? num(h.lossPct) : (rttMs != null ? 0 : 100);
  const responded = rttMs != null ? 1 : 0;
  const unresponsive = responded === 0;
  const { severity, reason } = classify({ lossPct, jitterMs, rttMs, responded, unresponsive });
  const geo = enrichGeo(ip, { geoProvider, cityProvider, centroids, origin }, { hostname: h.hostname, rttMs: num(h.minMs) ?? rttMs });
  return {
    kind: 'hop', hop, ip, label: ip || '* * *',
    country: geo.country, asn: geo.asn, asnName: geo.asnName, lat: geo.lat, lng: geo.lng, private: geo.private,
    hostname: geo.hostname, place: geo.place, geoRejected: geo.rejected,
    withinKm: Number.isFinite(geo.withinKm) ? geo.withinKm : null,
    fastestMs: num(h.minMs) ?? rttMs,
    rttMs, lossPct, jitterMs, responded, runs: 1, unresponsive, severity, explain: reason,
  };
}

// The hops of the traces that are running right now, so each new live hop is
// placed with the ones before it (settlePath) exactly as the finished path will
// be. Keyed per agent + probe type + target; a hop 1 or a trace idle for five
// minutes starts over. Holds the hops as described, BEFORE settling, and
// settles a fresh copy each time: a hop moved next to a city must not turn
// into a city anchor itself on the next pass.
function createLiveTraces({ ttlMs = 5 * 60 * 1000, maxTraces = 500, now = () => Date.now() } = {}) {
  const traces = new Map();
  const clone = (n) => ({ ...n, place: n.place ? { ...n.place } : null });

  function settle(key, node, origin = null) {
    if (!node) return null;
    let t = traces.get(key);
    if (!t || node.hop === 1 || now() - t.at > ttlMs) {
      t = { at: now(), raw: new Map() };
      traces.delete(key);
      traces.set(key, t);
      if (traces.size > maxTraces) traces.delete(traces.keys().next().value);
    }
    t.at = now();
    t.raw.set(node.hop, clone(node));
    const copies = [...t.raw.values()].map(clone);
    settlePath(copies.map((n) => ({ hop: n.hop, rttMs: n.fastestMs, node: n })), { origin });
    const out = copies.find((n) => n.hop === node.hop);
    const hint = origin && origin.source === 'agent'
      ? null
      : cloudOrigin(copies.sort((a, b) => a.hop - b.hop), { fastestOf: (n) => n.fastestMs });
    if (hint && hint.hop === out.hop) out.originHint = hint;
    return out;
  }

  return { settle, get size() { return traces.size; } };
}

module.exports = {
  buildPathGraph, describeLiveHop, createLiveTraces, PATH_PROBE_TYPES, buildBranches, hopMembers, ecmpAnalysis,
  THRESHOLDS: T, ECMP_MIN_SIGHTINGS, ECMP_LOSS_RISE_PCT,
  SEVERITY_RANK, WORST_MIN_RANK,
};
