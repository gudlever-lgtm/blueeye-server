'use strict';

const { isPrivate } = require('../geo/privateIp');

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
//   buildPathGraph(results, { geoProvider, centroids, target })
//     results  - probe rows (type 'traceroute') for ONE target, any order
//     deps     - optional geoProvider.lookup(ip) and centroids.get(country)

// Severity thresholds, shared with the fleet verdict so the colours mean the same
// thing everywhere (see public/app.js fleetKpis): loss% / jitter ms / latency ms.
const T = {
  loss: { warn: 2, bad: 20 },
  jitter: { warn: 30, bad: 100 },
  latency: { warn: 120, bad: 250 },
};

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

function enrichGeo(ip, geoProvider, centroids) {
  if (!ip || isPrivate(ip) || !geoProvider) return { country: null, asn: null, asnName: null, lat: null, lng: null, private: !!(ip && isPrivate(ip)) };
  const geo = geoProvider.lookup(ip) || null;
  const country = geo && geo.country ? geo.country : null;
  const point = country && centroids ? centroids.get(country) : null;
  return {
    country,
    asn: geo ? geo.asn ?? null : null,
    asnName: geo ? geo.asnName ?? null : null,
    lat: point ? point.lat : null,
    lng: point ? point.lng : null,
    private: false,
  };
}

function buildPathGraph(results, { geoProvider = null, centroids = null, target = null, origin = null } = {}) {
  const runs = (Array.isArray(results) ? results : [])
    .filter((r) => r && r.type === 'traceroute' && Array.isArray(r.hops));
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

  // Bucket every hop by its TTL position across all runs.
  const byPos = new Map();
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
    const geo = enrichGeo(ip, geoProvider, centroids);
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
  const sevRank = { bad: 3, warn: 2, ok: 1, muted: 0 };
  let worstHopIndex = null;
  let worstRank = 0;
  for (const n of nodes) {
    if (n.kind === 'source') continue;
    const r = sevRank[n.severity] || 0;
    if (r > worstRank && r >= sevRank.warn) { worstRank = r; worstHopIndex = n.index; }
  }

  const branches = buildBranches(runs, byPos, maxPos, { geoProvider, centroids });

  return { ...meta, worstHopIndex, nodes, links, branches };
}

// ECMP / multipath inference — server-only, from the runs already stored (no
// agent change). Load-balancers make the responding IP at one TTL vary run to
// run; the linear graph above collapses that to the single mode IP. Here we keep
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
function buildBranches(runs, byPos, maxPos, { geoProvider = null, centroids = null } = {}) {
  // Per (position, ip): accumulate the samples so each branch carries its own
  // aggregated metrics, exactly like the linear nodes but split by IP.
  const perPos = new Map(); // pos -> Map(ip -> { rtt:[], loss:[], jitter:[], responded, runs })
  const edgeCounts = new Map(); // "fromHop|fromIp|toHop|toIp" -> count
  let multipath = false;

  for (const run of runs) {
    // Ordered, responding hops in this run (skip silent/no-IP hops so branches
    // stay connected across a silent router).
    const seq = [];
    for (const h of run.hops) {
      const pos = Number(h.hop);
      if (!Number.isInteger(pos) || pos < 1) continue;
      const ip = h.ip || null;
      if (ip == null || h.rttMs == null) continue; // only responding hops branch
      if (!perPos.has(pos)) perPos.set(pos, new Map());
      const ipMap = perPos.get(pos);
      if (!ipMap.has(ip)) ipMap.set(ip, { rtt: [], loss: [], jitter: [], responded: 0, runs: 0 });
      const b = ipMap.get(ip);
      b.runs += 1;
      b.responded += 1;
      b.rtt.push(h.rttMs);
      if (h.jitterMs != null) b.jitter.push(h.jitterMs);
      b.loss.push(h.lossPct != null ? h.lossPct : 0);
      seq.push({ pos, ip });
    }
    // Consecutive responding hops become a directed transition (the branch edge).
    for (let i = 1; i < seq.length; i += 1) {
      const a = seq[i - 1];
      const b = seq[i];
      const key = `${a.pos}|${a.ip}|${b.pos}|${b.ip}`;
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
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
      const geo = enrichGeo(ip, geoProvider, centroids);
      const { severity, reason } = classify({ lossPct, jitterMs, rttMs, responded: b.responded, unresponsive: false });
      ips.push({
        ip, asn: geo.asn, asnName: geo.asnName, country: geo.country, private: geo.private,
        lat: geo.lat, lng: geo.lng,
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

module.exports = { buildPathGraph, buildBranches, THRESHOLDS: T };
