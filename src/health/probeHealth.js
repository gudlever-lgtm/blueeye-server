'use strict';

const { throughputHealthSummary } = require('./throughputHealth');

// Fleet probe-health: turns an agent's recent active-probe results (ping / TCP /
// DNS / traceroute) into a single, explainable health verdict driven by the
// three signals a network/firewall tech reasons about — reachability, loss,
// latency and jitter. Pure + dependency-free so it is unit-tested directly and
// reused by the /api/fleet route and (per-agent) drill-down.
//
// "Local + explainable" per the repo conventions: latency is judged against the
// agent's OWN recent baseline using robust statistics (median + MAD z-score),
// never a fixed RTT threshold (what is "slow" depends on the target — a LAN
// gateway vs. a transatlantic host). Loss and reachability are absolute. Every
// verdict carries a human reason + evidence rows.

// Thresholds (tunable, named so the verdict is auditable).
const LOSS_WARN = 2; // % packet loss
const LOSS_BAD = 20;
const JITTER_WARN = 30; // ms
const JITTER_BAD = 100;
const Z_WARN = 3; // robust z-score of latest RTT vs. the target's own baseline
const Z_BAD = 6;
const MIN_BASELINE = 8; // samples before a latency baseline is trusted
const STALE_MS = 15 * 60 * 1000; // newest probe older than this ⇒ data is stale
const MAD_TO_SIGMA = 1.4826; // MAD ⇒ std-dev for a normal distribution

const round1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const round2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

// Linear-interpolated percentile of an already-sorted ascending array.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Robust centre + spread: median and Median Absolute Deviation. Resistant to the
// odd timeout spike that would wreck a mean/std-dev.
function robustStats(values) {
  const xs = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = xs.length;
  if (!n) return { n: 0, median: null, mad: null };
  const median = percentile(xs, 0.5);
  const dev = xs.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  return { n, median, mad: percentile(dev, 0.5) };
}

// Worst (most severe) status wins.
const TIER = { down: 0, bad: 1, warn: 2, stale: 3, unknown: 4, ok: 5 };
const worse = (a, b) => (TIER[a] <= TIER[b] ? a : b);

// Per-(type,target) summary from that target's recent samples (newest-first).
function summarizeTarget(samples) {
  const latest = samples[0];
  const base = robustStats(samples.map((s) => s.rttMs));
  let z = 0;
  if (Number.isFinite(latest.rttMs) && base.n >= MIN_BASELINE && base.median != null) {
    const sigma = (base.mad || 0) * MAD_TO_SIGMA;
    z = sigma > 0 ? (latest.rttMs - base.median) / sigma : 0;
  }
  return {
    type: latest.type,
    target: latest.target,
    ok: latest.ok === true,
    rttMs: Number.isFinite(latest.rttMs) ? latest.rttMs : null,
    baselineMs: base.median,
    baselineN: base.n,
    z: z > 0 ? z : 0, // only elevated latency is a problem, not faster-than-usual
    lossPct: Number.isFinite(latest.lossPct) ? latest.lossPct : null,
    jitterMs: Number.isFinite(latest.jitterMs) ? latest.jitterMs : null,
    ts: latest.ts,
  };
}

// Reduce one agent's recent probe rows to a health verdict. `rows` are this
// agent's rows, newest-first; each { ts, type, target, ok, rttMs, jitterMs, lossPct }.
function computeAgentHealth(rows, { now = Date.now() } = {}) {
  const empty = {
    status: 'unknown',
    reason: 'No probe data yet — run a probe from the agent.',
    evidence: [],
    metrics: { targets: 0, reachable: 0, unreachable: 0, lossPct: null, rttMs: null, baselineMs: null, latencyZ: null, jitterMs: null, lastTs: null },
  };
  if (!Array.isArray(rows) || rows.length === 0) return empty;

  // Group by (type,target), preserving newest-first order within each group.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.type}|${r.target}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const targets = [...groups.values()].map(summarizeTarget);
  if (!targets.length) return empty;

  const reachable = targets.filter((t) => t.ok);
  const unreachable = targets.filter((t) => !t.ok);
  const lastTs = targets.reduce((m, t) => (t.ts && (!m || t.ts > m) ? t.ts : m), null);
  const ageMs = lastTs ? now - new Date(lastTs).getTime() : Infinity;

  // Worst-of each signal, remembering which target drove it (for evidence).
  const maxBy = (list, sel) => list.reduce((best, t) => (sel(t) != null && (best == null || sel(t) > sel(best)) ? t : best), null);
  const worstLoss = maxBy(targets, (t) => t.lossPct);
  const worstLat = maxBy(targets, (t) => t.z);
  const slowest = maxBy(targets, (t) => t.rttMs);
  const worstJit = maxBy(targets, (t) => t.jitterMs);

  let status = 'ok';
  const evidence = [];
  const note = (metric, t, extra) => evidence.push({ metric, target: t.target, type: t.type, ...extra });

  if (unreachable.length === targets.length) {
    status = 'down';
    note('reachability', unreachable[0], { ok: false, of: targets.length, unreachable: unreachable.length });
  } else {
    if (unreachable.length) { status = worse(status, 'bad'); note('reachability', unreachable[0], { ok: false, of: targets.length, unreachable: unreachable.length }); }
    if (worstLoss && worstLoss.lossPct >= LOSS_BAD) { status = worse(status, 'bad'); note('loss', worstLoss, { lossPct: round1(worstLoss.lossPct) }); }
    else if (worstLoss && worstLoss.lossPct >= LOSS_WARN) { status = worse(status, 'warn'); note('loss', worstLoss, { lossPct: round1(worstLoss.lossPct) }); }
    if (worstLat && worstLat.z >= Z_BAD) { status = worse(status, 'bad'); note('latency', worstLat, { rttMs: round1(worstLat.rttMs), baselineMs: round1(worstLat.baselineMs), z: round1(worstLat.z) }); }
    else if (worstLat && worstLat.z >= Z_WARN) { status = worse(status, 'warn'); note('latency', worstLat, { rttMs: round1(worstLat.rttMs), baselineMs: round1(worstLat.baselineMs), z: round1(worstLat.z) }); }
    if (worstJit && worstJit.jitterMs >= JITTER_BAD) { status = worse(status, 'bad'); note('jitter', worstJit, { jitterMs: round1(worstJit.jitterMs) }); }
    else if (worstJit && worstJit.jitterMs >= JITTER_WARN) { status = worse(status, 'warn'); note('jitter', worstJit, { jitterMs: round1(worstJit.jitterMs) }); }
  }

  // Quiet/offline agent: a healthy-but-old verdict is "stale", not "ok".
  const stale = ageMs > STALE_MS;
  if (stale && status === 'ok') status = 'stale';

  const metrics = {
    targets: targets.length,
    reachable: reachable.length,
    unreachable: unreachable.length,
    lossPct: worstLoss ? round1(worstLoss.lossPct) : 0,
    rttMs: slowest ? round1(slowest.rttMs) : null,
    baselineMs: worstLat ? round1(worstLat.baselineMs) : (slowest ? round1(slowest.baselineMs) : null),
    latencyZ: worstLat ? round1(worstLat.z) : 0,
    jitterMs: worstJit ? round1(worstJit.jitterMs) : null,
    lastTs,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
  };
  return { status, reason: reasonFor(status, metrics, evidence, stale), evidence, metrics };
}

// A one-line explanation of the verdict (the headline in the UI/title).
function reasonFor(status, m, evidence, stale) {
  if (status === 'unknown') return 'No probe data yet — run a probe from the agent.';
  const top = evidence[0];
  const staleNote = stale && status !== 'stale' ? ' (data is stale)' : '';
  if (status === 'stale') return `No fresh measurements — latest probe is > 15 min. old.`;
  if (status === 'down') return `All ${m.targets} targets are not responding.`;
  if (!top) return `All ${m.reachable} targets are healthy — low latency, no loss.`;
  if (top.metric === 'reachability') return `${m.unreachable}/${m.targets} targets not responding (e.g. ${top.target}).${staleNote}`;
  if (top.metric === 'loss') return `Packet loss ${top.lossPct}% to ${top.target}.${staleNote}`;
  if (top.metric === 'latency') return `Latency ${top.rttMs} ms to ${top.target} — ~${top.baselineMs} ms normal (z=${top.z}).${staleNote}`;
  if (top.metric === 'jitter') return `Jitter ${top.jitterMs} ms to ${top.target}.${staleNote}`;
  return 'Healthy.';
}

// Worst of two statuses. 'unknown' is TIER-ranked like any other status, so a
// *concerning* signal (warn/bad/down) from one source still surfaces when the
// other says nothing — but a merely-OK signal never upgrades an 'unknown' into a
// confident 'ok'. A healthy link (or a passing speed test) does not, on its own,
// prove reachability/loss/latency are fine; only real probe data can vouch for
// that. Folding an OK-but-partial signal into 'ok' is what let a disconnected /
// no-probe-data agent read HEALTHY off a single (often stale) interface reading.
function combineStatus(a, b) {
  return TIER[a] <= TIER[b] ? a : b;
}

// Fold an agent's interface signal into its probe verdict. `iface` is an
// interfaceHealthSummary ({ status, worst, count, issues }) or null. A single
// link being down is 'bad' at the agent level (one unused port ≠ unreachable),
// not 'down'. Returns a new verdict; the probe verdict is returned unchanged
// when there is no interface data.
function mergeHealth(probe, iface) {
  if (!iface || !iface.status) return probe;
  const ifaceTier = iface.status === 'down' ? 'bad' : iface.status; // ok|warn|bad
  const status = combineStatus(probe.status, ifaceTier);
  const w = iface.worst || {};
  // The interface is the headline only when it is the (strictly) dominant signal
  // — i.e. it is a *worse* signal than the probe verdict. A healthy interface is
  // never the headline: it must not relabel an 'unknown' (no probe data) verdict
  // as "Interfaces healthy." and mask that we cannot actually vouch for the agent.
  const ifaceDrives = TIER[ifaceTier] < TIER[probe.status];
  const evidence = ifaceDrives
    ? [{ metric: 'interface', iface: w.iface, status: iface.status, errPerSec: w.errPerSec, dropPerSec: w.dropPerSec, operStatus: w.operStatus, utilPct: w.utilPct }, ...probe.evidence]
    : [...probe.evidence, { metric: 'interface', iface: w.iface, status: iface.status, errPerSec: w.errPerSec, dropPerSec: w.dropPerSec }];
  const reason = ifaceDrives ? interfaceReason(iface) : probe.reason;
  return {
    status,
    reason,
    evidence,
    metrics: { ...probe.metrics, ifaceStatus: iface.status, ifaceCount: iface.count, ifaceIssues: iface.issues, worstIface: w.iface || null },
  };
}

function interfaceReason(iface) {
  const w = iface.worst || {};
  const where = w.iface ? ` (${w.iface})` : '';
  if (iface.status === 'down') return `Link down${where}.`;
  if (iface.status === 'bad') return w.errPerSec > 0 ? `Interface errors ${w.errPerSec}/s${where}.` : `Interface nearly saturated${where}.`;
  if (iface.status === 'warn') return w.dropPerSec > 0 ? `Interface discards ${w.dropPerSec}/s${where}.` : `High interface utilisation${where}.`;
  return 'Interfaces healthy.';
}

// Fold an agent's active-throughput signal into its verdict. `thr` is a
// throughputHealthSummary ({ status: ok|warn|bad, downMbps, upMbps, reason }) or
// null (disabled / no measurement → verdict unchanged). Mirrors mergeHealth: the
// throughput becomes the headline only when it is the dominant signal.
function mergeThroughput(health, thr) {
  if (!thr || !thr.status) return health;
  const status = combineStatus(health.status, thr.status);
  // As with the interface fold: throughput is the headline only when it is a
  // worse signal. A passing speed test alone never manufactures a HEALTHY verdict.
  const drives = TIER[thr.status] < TIER[health.status];
  const ev = { metric: 'throughput', downMbps: thr.downMbps, upMbps: thr.upMbps, status: thr.status };
  const evidence = drives ? [ev, ...health.evidence] : [...health.evidence, ev];
  const reason = drives ? thr.reason : health.reason;
  return {
    status,
    reason,
    evidence,
    metrics: { ...health.metrics, downMbps: thr.downMbps, upMbps: thr.upMbps, throughputStatus: thr.status },
  };
}

// Fold the agent's live connection state into its verdict. A disconnected agent
// is not reporting, so its probe/interface/throughput readings are — by
// definition — stale and cannot vouch for current health: it must never read
// HEALTHY (or a confident UNKNOWN) just because the last data on file looked
// fine. `offline` is the WS-connection state (agents.status === 'offline').
// Mirrors mergeHealth/mergeThroughput: the disconnection is the headline only
// when the last-known verdict wasn't a worse, concrete problem — a real
// loss/latency/link-down signal still leads, with the disconnection kept as
// evidence. A `down`/`stale` floor (not a new tier) keeps the existing badge
// palette + fleet chips intact; the separate online/offline pill names the
// disconnection explicitly.
function mergeConnection(health, offline) {
  if (!offline) return health;
  const status = combineStatus(health.status, 'stale');
  const drives = TIER.stale <= TIER[health.status];
  const ev = { metric: 'connection', online: false };
  const evidence = drives ? [ev, ...health.evidence] : [...health.evidence, ev];
  const reason = drives ? 'Agent disconnected — not reporting (readings may be stale).' : health.reason;
  return { status, reason, evidence, metrics: { ...health.metrics, online: false } };
}

// Build the fleet rollup: each agent's identity + health verdict (probe verdict
// merged with its interface signal), plus a summary count per status.
// `rowsByAgentId` maps agentId ⇒ recent probe rows (newest-first); optional
// `ifaceByAgentId` maps agentId ⇒ interfaceHealthSummary. Sorted worst-first.
function computeFleet(agents, rowsByAgentId, { now = Date.now(), ifaceByAgentId = {}, throughputByAgentId = {}, throughputThresholds = null } = {}) {
  const list = (agents || []).map((a) => {
    const probe = computeAgentHealth(rowsByAgentId[a.id] || rowsByAgentId[String(a.id)] || [], { now });
    const iface = ifaceByAgentId[a.id] || ifaceByAgentId[String(a.id)] || null;
    let health = mergeHealth(probe, iface);
    const latestThr = throughputByAgentId[a.id] || throughputByAgentId[String(a.id)] || null;
    const thr = throughputHealthSummary(latestThr, throughputThresholds || {});
    if (thr) health = mergeThroughput(health, thr);
    health = mergeConnection(health, a.status === 'offline');
    return {
      agentId: a.id,
      hostname: a.hostname,
      displayName: a.display_name || a.hostname,
      locationId: a.location_id ?? null,
      locationName: a.location_name || null,
      online: a.status === 'online',
      status: a.status,
      lastReportAt: a.last_report_at || null,
      health,
      // Latest speed test (surfaced even when thresholds are off, so the overview
      // can show throughput). null when the agent has never run one.
      throughput: latestThr
        ? { downMbps: round1(latestThr.down_mbps), upMbps: round1(latestThr.up_mbps), ts: latestThr.ts || null, ok: latestThr.ok === 1 || latestThr.ok === true }
        : null,
    };
  });
  list.sort((x, y) => (TIER[x.health.status] - TIER[y.health.status])
    || ((y.health.metrics.latencyZ || 0) - (x.health.metrics.latencyZ || 0))
    || String(x.displayName).localeCompare(String(y.displayName)));
  const summary = { ok: 0, warn: 0, bad: 0, down: 0, stale: 0, unknown: 0, offline: 0, total: list.length };
  for (const a of list) {
    summary[a.health.status] = (summary[a.health.status] || 0) + 1;
    if (!a.online) summary.offline += 1; // connection state (independent of the health verdict)
  }
  return { agents: list, summary };
}

module.exports = {
  computeAgentHealth,
  computeFleet,
  mergeHealth,
  mergeThroughput,
  mergeConnection,
  robustStats,
  // exported for tests / tuning visibility
  THRESHOLDS: { LOSS_WARN, LOSS_BAD, JITTER_WARN, JITTER_BAD, Z_WARN, Z_BAD, MIN_BASELINE, STALE_MS },
};
