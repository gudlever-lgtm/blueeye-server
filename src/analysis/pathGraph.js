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

  return { ...meta, nodes, links };
}

module.exports = { buildPathGraph, THRESHOLDS: T };
