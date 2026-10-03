'use strict';

const { throughputHealthSummary } = require('./throughputHealth');
// The probe types that do not vote on reachability (path_mtu, tls, rdns, dhcp)
// — one list, owned by the repository whose SQL already leaves them out of the
// fleet-health read and the uptime figure.
const { DIAGNOSTIC_TYPES } = require('../repositories/probeResultsRepository');

// AGENT HEALTH ANSWERS ONE QUESTION: can the server rely on this agent?
//
// It used to answer a different one — "is everything this agent measures
// healthy" — and the two are not the same. An agent whose traceroute to
// us.cnn.com lost a hop somewhere on the internet was CRITICAL: red in the
// fleet, red on the map, counted in the critical chip. Nothing was wrong with
// the agent. Nothing was wrong with the customer's network either. A router on
// the far side of the Atlantic declined to send an ICMP time-exceeded, which is
// a thing routers do by configuration.
//
// Red that means "somebody else's network did something ordinary" is red
// nobody reads. So the verdict is now about the agent itself:
//
//   CRITICAL  the agent is not reporting; its own segment is unreachable (the
//             gateway and the hosts on its own subnet); its own condition is
//             broken (clock skew, dropped collector datagrams — its numbers
//             cannot be trusted); or an attack indication is open on it.
//   WARNING   something about the agent is off but its reports still stand —
//             an interface with errors, data quality degrading.
//   STALE     connected, but nothing fresh has arrived.
//   HEALTHY   reporting, fresh, nothing wrong with the agent.
//
// What the agent measures OUT THERE — loss, latency, jitter, a public target
// not answering — is still measured, still carried in `metrics` and `evidence`,
// and still raises its own findings (src/analysis/probeFindings.js) which land
// on Analysis and in the Changes feed. It just does not decide whether the
// AGENT is healthy. The evidence rows for it carry `external: true`, so the
// fold below can tell the two apart and so can a reader of the API.
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
// Robust z-score of latest RTT vs. the target's own baseline. Latency is a
// WARNING signal only — however far it moves, it never makes an agent 'bad'
// (and so never a CRIT finding). CRIT is kept for the target being gone:
// unreachable, heavy loss, or jitter bad enough to break real-time traffic.
const Z_WARN = 3;

// HOW FAR THE LATENCY ACTUALLY MOVED, which the z-score on its own does not say.
//
// A stable LAN target has a baseline like 0.5 ms with a MAD of a few tens of
// MICROSECONDS. Divide an ordinary 0.4 ms wobble by a 54 us sigma and the answer
// is z=7.4 — past what was then Z_BAD, so "critical", on a link nobody would call slow. That is
// not a broken statistic, it is a correct statistic answering the wrong question:
// "is this unusual for this target" instead of "is this worth waking someone for".
// In the field it produced 30 003 criticals out of 184 668 findings, which is the
// same as having none.
//
// So elevated latency has to clear BOTH bars before the z-score is consulted:
//
//   at least LAT_MIN_DELTA_MS above baseline   — a sub-5 ms move is never news,
//                                                however many sigmas it is;
//   at least LAT_MIN_FRACTION above baseline   — and on a 200 ms WAN path, 5 ms
//                                                is not news either.
//
// Loss and jitter already work this way (LOSS_WARN, JITTER_WARN are absolute).
// Latency was the one signal judged on nothing but its own variance.
const LAT_MIN_DELTA_MS = 5;
const LAT_MIN_FRACTION = 0.2;
const MIN_BASELINE = 8; // samples before a latency baseline is trusted
const STALE_MS = 15 * 60 * 1000; // newest probe older than this ⇒ data is stale
const MAD_TO_SIGMA = 1.4826; // MAD ⇒ std-dev for a normal distribution

// IS THIS TARGET ON THE AGENT'S OWN SEGMENT?
//
// The agent auto-probes its default gateway and its resolvers, and an operator
// adds the hosts that matter locally. Those are the targets whose silence says
// something about the AGENT: if its own gateway does not answer, it is
// network-isolated, and the connection to this server is living on borrowed
// time. A public target that does not answer says something about the internet.
//
// WHY AN ADDRESS TEST AND NOT A ROLE FLAG. The agent tags its gateway probe
// `role: 'gateway'` internally, but that tag never reaches the wire — adding it
// means a migration, an agent release and a fleet that only tells the truth
// once every host has updated (there are v0.11 agents in the field). A private
// address is a fact the server already has, on every row, from every agent
// version.
//
// It is a PROXY, and an honest one: a private target that is not the gateway
// counts too. That is the right error to make — a LAN host the operator chose
// to watch going silent is about this network, which is what this verdict is
// about. A hostname is treated as external: a name that resolves to a private
// address is rare on purpose here, and guessing would need a resolver.
const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local: no DHCP answered, which is its own kind of local
  /^127\./,
];

function isOwnSegment(target) {
  const raw = String(target == null ? '' : target).trim();
  if (!raw) return false;
  // Strip a :port (tcp targets) and IPv6 brackets.
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':').length === 2 ? raw.split(':')[0] : raw;
  if (/^(::1|fe80:|fc|fd)/i.test(host)) return true; // IPv6 loopback, link-local, unique-local
  return PRIVATE_V4.some((re) => re.test(host));
}

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
//
// The sample being judged is the latest one, and it is NOT part of the baseline
// it is judged against: the baseline is everything before it. Including it let
// the value under test pull the median toward itself and widen the MAD by its
// own distance — a small effect with many samples, a large one near
// MIN_BASELINE, and in every case the wrong question ("is this unusual compared
// with a history that already contains it?").
//
// What this does NOT change: the baseline is a rolling window (the caller's —
// 6 h in the probe pipeline), and a median follows the majority. Degradation
// that persists for more than about half the window becomes the new normal and
// stops being reported as latency; loss, reachability and jitter are absolute
// and keep reporting. A longer window would hold the old normal longer but also
// be slower to accept a legitimate change (a new route, a moved server), and
// costs a larger read on every probe ingest — so the default stays at 6 h.
function summarizeTarget(samples) {
  const latest = samples[0];
  const base = robustStats(samples.slice(1).map((s) => s.rttMs));
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

// Did the latency move far enough to be worth a verdict at all? Both bars, for
// the reasons at LAT_MIN_DELTA_MS. A target with no usable baseline has nothing
// to have moved FROM, so it does not qualify — the z-score is already 0 there.
function latencyMoved(t) {
  if (!t || !Number.isFinite(t.rttMs) || !Number.isFinite(t.baselineMs)) return false;
  const delta = t.rttMs - t.baselineMs;
  return delta >= LAT_MIN_DELTA_MS && delta >= t.baselineMs * LAT_MIN_FRACTION;
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

  // Diagnostic probes are judged on their own terms (probeFindings.js) and
  // never count as targets here — the same rule the fleet-health read applies
  // in SQL (probeResultsRepository.fleetHealth). A DHCP test that heard no
  // offer, or a TLS handshake a plain-HTTP port refused, is not "1/5 targets
  // not responding": every caller that hands this function an agent's raw
  // rows (the probe findings, the per-agent fleet drill-down, the export, the
  // assistant) used to count them as if they were.
  const measured = rows.filter((r) => r && !DIAGNOSTIC_TYPES.includes(r.type));
  if (!measured.length) return empty;

  // Group by (type,target), preserving newest-first order within each group.
  const groups = new Map();
  for (const r of measured) {
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
  // Each evidence row carries its OWN level ('warn' | 'bad' | 'down'), so a
  // warn-grade signal is not promoted to CRIT just because a different signal
  // on the same agent is bad.
  const note = (level, metric, t, extra) => evidence.push({ metric, level, target: t.target, type: t.type, ...extra });

  // THE AGENT'S OWN SEGMENT decides the verdict. Its gateway and the hosts on
  // its own subnet are the network the agent lives on; if they stop answering,
  // it is isolated and the connection to this server is living on borrowed
  // time. That is a CRITICAL about the agent.
  const ownSegment = targets.filter((t) => isOwnSegment(t.target));
  const localDown = ownSegment.filter((t) => !t.ok);

  if (ownSegment.length && localDown.length === ownSegment.length) {
    // Everything local is silent: not one hop of this agent's own network
    // answers. 'down' rather than 'bad' — there is nothing left to be partly
    // right about.
    status = 'down';
    note('down', 'reachability', localDown[0], { ok: false, of: ownSegment.length, unreachable: localDown.length, scope: 'local' });
  } else if (localDown.length) {
    status = worse(status, 'bad');
    note('bad', 'reachability', localDown[0], { ok: false, of: ownSegment.length, unreachable: localDown.length, scope: 'local' });
  }

  // EVERYTHING BEYOND IT IS EVIDENCE, NOT A VERDICT.
  //
  // These rows KEEP THEIR REAL LEVEL — 'warn' and 'bad', exactly as before —
  // because they are also what src/analysis/probeFindings.js turns into
  // findings, and a target on the internet going dark is still a CRIT finding
  // on the Analysis screen and in the Changes feed. That is where it belongs.
  // What changed is that `external: true` keeps them out of the agent's own
  // verdict and out of its headline: the finding is raised, the badge stays
  // green, and the two statements are both true.
  //
  // Downgrading the level instead would have been the easy version of this
  // change and the wrong one: it silently stops raising the findings as well,
  // and then nothing anywhere says the target is down.
  const externalDown = unreachable.filter((t) => !isOwnSegment(t.target));
  if (externalDown.length) {
    note('bad', 'reachability', externalDown[0], { ok: false, of: targets.length, unreachable: externalDown.length, external: true });
  }

  // A target that did not answer at all has 100% loss by definition, so when
  // NOTHING answered, "unreachable" and "100% loss" are two names for one fact
  // and only the first is worth a row (and a finding). The signals below are
  // therefore read only while something is still answering — which is what the
  // old if/else shape did, kept here deliberately rather than by accident.
  const externalNote = (metric, t, extra, level = 'warn') => { if (t && !isOwnSegment(t.target)) note(level, metric, t, { ...extra, external: true }); };
  const somethingAnswers = unreachable.length < targets.length;
  if (somethingAnswers && worstLoss && worstLoss.lossPct >= LOSS_WARN) {
    if (isOwnSegment(worstLoss.target)) {
      // Loss on the agent's own segment IS about the agent's network.
      const level = worstLoss.lossPct >= LOSS_BAD ? 'bad' : 'warn';
      status = worse(status, level);
      note(level, 'loss', worstLoss, { lossPct: round1(worstLoss.lossPct), scope: 'local' });
    } else externalNote('loss', worstLoss, { lossPct: round1(worstLoss.lossPct) }, worstLoss.lossPct >= LOSS_BAD ? 'bad' : 'warn');
  }
  // `latencyMoved` is the gate described at LAT_MIN_DELTA_MS: a z-score on a
  // target that barely moved says nothing worth reporting.
  const latMoved = somethingAnswers && worstLat ? latencyMoved(worstLat) : false;
  if (latMoved && worstLat.z >= Z_WARN) {
    if (isOwnSegment(worstLat.target)) { status = worse(status, 'warn'); note('warn', 'latency', worstLat, { rttMs: round1(worstLat.rttMs), baselineMs: round1(worstLat.baselineMs), z: round1(worstLat.z), scope: 'local' }); }
    else externalNote('latency', worstLat, { rttMs: round1(worstLat.rttMs), baselineMs: round1(worstLat.baselineMs), z: round1(worstLat.z) });
  }
  if (somethingAnswers && worstJit && worstJit.jitterMs >= JITTER_WARN) {
    if (isOwnSegment(worstJit.target)) {
      // Jitter is graded like loss, and for the same reason: on the agent's OWN
      // segment these two say the link under it is failing — a hundred
      // milliseconds of jitter to your own gateway is a duplex mismatch or a
      // dying switch port, not a busy internet. The connection this agent
      // reports over runs across that link.
      const level = worstJit.jitterMs >= JITTER_BAD ? 'bad' : 'warn';
      status = worse(status, level);
      note(level, 'jitter', worstJit, { jitterMs: round1(worstJit.jitterMs), scope: 'local' });
    } else externalNote('jitter', worstJit, { jitterMs: round1(worstJit.jitterMs) }, worstJit.jitterMs >= JITTER_BAD ? 'bad' : 'warn');
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
  // The headline comes from what DROVE the verdict. An `info` row is a
  // measurement about somewhere else — it is carried, shown and turned into its
  // own finding, but it must never be the sentence under a HEALTHY badge.
  const top = evidence.find((e) => e && !e.external);
  const staleNote = stale && status !== 'stale' ? ' (data is stale)' : '';
  if (status === 'stale') return `No fresh measurements — latest probe is > 15 min. old.`;
  if (status === 'down') return `Nothing on this agent's own network is responding (e.g. ${(evidence.find((e) => e.scope === 'local') || {}).target || 'its gateway'}).`;
  if (!top) {
    // Healthy agent, and possibly a sick internet. Say both, in that order.
    const external = m.targets - m.reachable;
    if (external > 0) return `The agent is healthy. ${external} of ${m.targets} targets outside its own network are not responding — see its findings.`;
    return `All ${m.reachable} targets are healthy — low latency, no loss.`;
  }
  if (top.metric === 'reachability') return `${top.unreachable}/${top.of} targets on this agent's own network not responding (e.g. ${top.target}).${staleNote}`;
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
  // CAPPED AT A WARNING. A port with errors, or one link down out of twelve, is
  // worth saying — it is the agent's own hardware — but it does not make the
  // agent unreliable, and an unused port that has been down since the machine
  // was racked must not sit in the critical chip for ever. The interface
  // findings carry the detail, and the Ports panel on the agent shows it.
  const ifaceTier = iface.status === 'down' || iface.status === 'bad' ? 'warn' : iface.status; // ok|warn
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
  // A named cause beats a bare error rate: "errors 3/s" sends someone to the
  // cable, "duplex mismatch" sends them to the port configuration, and only
  // one of those is the fix (src/health/interfaceHealth.js reasonsOf).
  const reasons = Array.isArray(w.reasons) ? w.reasons : [];
  if (reasons.includes('duplex_mismatch')) return `Duplex mismatch suspected${where}: half duplex with collisions or frame errors increasing.`;
  if (reasons.includes('crc_errors')) return `Frame/CRC errors ${w.frameErrPerSec}/s${where} — suspect cabling, patch lead or SFP.`;
  if (reasons.includes('carrier_errors')) return `Carrier errors ${w.carrierErrPerSec}/s${where} — the link is flapping or the cabling is bad.`;
  if (iface.status === 'bad') return w.errPerSec > 0 ? `Interface errors ${w.errPerSec}/s${where}.` : `Interface nearly saturated${where}.`;
  if (iface.status === 'warn' && reasons.includes('half_duplex')) return `Link negotiated half duplex${where}.`;
  if (iface.status === 'warn' && reasons.includes('fifo_overrun')) return `NIC receive FIFO overruns ${w.fifoErrPerSec}/s${where} — the host is not draining the NIC fast enough.`;
  if (iface.status === 'warn') return w.dropPerSec > 0 ? `Interface discards ${w.dropPerSec}/s${where}.` : `High interface utilisation${where}.`;
  return 'Interfaces healthy.';
}

// Fold the agent's own DATA QUALITY into its verdict (src/health/dataQuality.js:
// clock skew against the server, collector datagrams dropped, agent version).
//
// THIS IS ABOUT THE AGENT, so unlike the measurements it takes, it does decide.
// An agent whose clock is a minute out timestamps everything it reports wrongly
// — its findings land in the wrong place on every timeline, and a correlation
// window that should have caught two events together misses them. An agent
// dropping 5% of the datagrams it was sent is not measuring the traffic it
// claims to measure. Both mean: do not trust this agent's numbers, which is
// exactly what a health verdict is for.
function mergeQuality(health, quality) {
  if (!quality || !quality.status || quality.status === 'unknown') return health;
  const tier = quality.status === 'bad' ? 'bad' : quality.status; // ok|warn|bad
  const status = combineStatus(health.status, tier);
  const drives = TIER[tier] < TIER[health.status];
  const ev = { metric: 'quality', level: tier, status: quality.status, clockSkewMs: quality.clockSkewMs, dropPct: quality.dropPct, version: quality.version };
  const evidence = drives ? [ev, ...health.evidence] : [...health.evidence, ev];
  return {
    status,
    reason: drives ? quality.reason : health.reason,
    evidence,
    metrics: { ...health.metrics, qualityStatus: quality.status },
  };
}

// Fold an OPEN ATTACK INDICATION on this agent into its verdict
// (src/analysis/attackIndication.js decides what counts as one, and the same
// corroboration rule the red line uses applies — a lone WARN is a candidate,
// not a conclusion).
//
// An agent reporting a host sweeping its network is not an unhealthy agent in
// the strict sense: it is doing its job, well. But the fleet list is where
// somebody looks first, and an agent that has something attacking the network
// it watches should not sit there in green while it does. `attack` is
// { count, worst, metric, explanation } or null.
function mergeAttack(health, attack) {
  if (!attack || !attack.count) return health;
  const status = combineStatus(health.status, 'bad');
  const drives = TIER.bad < TIER[health.status];
  const ev = { metric: 'attack', level: 'bad', count: attack.count, worst: attack.worst || null, attackMetric: attack.metric || null };
  const evidence = drives ? [ev, ...health.evidence] : [...health.evidence, ev];
  const reason = drives
    ? (attack.count === 1
      ? `Attack indication on this agent: ${attack.metric || 'see findings'}.`
      : `${attack.count} attack indications on this agent (worst ${attack.worst || 'WARN'}).`)
    : health.reason;
  return { status, reason, evidence, metrics: { ...health.metrics, attackCount: attack.count } };
}

// Fold an agent's active-throughput signal into its verdict. `thr` is a
// throughputHealthSummary ({ status: ok|warn|bad, downMbps, upMbps, reason }) or
// null (disabled / no measurement → verdict unchanged). Mirrors mergeHealth: the
// throughput becomes the headline only when it is the dominant signal.
// A SPEED TEST MEASURES THE INTERNET, so it is evidence and never a verdict.
// It runs against a server out on the far side of the customer's uplink: a slow
// result is their ISP, the far end, or the time of day — not the agent. It is
// still carried (the Fleet row shows the Mbps, and the throughput finding is
// raised as before), just no longer able to colour an agent red for a bad
// evening on a shared line.
function mergeThroughput(health, thr) {
  if (!thr || !thr.status) return health;
  const ev = { metric: 'throughput', level: 'info', external: true, downMbps: thr.downMbps, upMbps: thr.upMbps, status: thr.status };
  return {
    status: health.status,
    reason: health.reason,
    evidence: [...health.evidence, ev],
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
  mergeQuality,
  mergeAttack,
  isOwnSegment,
  computeAgentHealth,
  computeFleet,
  mergeHealth,
  mergeThroughput,
  mergeConnection,
  robustStats,
  // exported for tests / tuning visibility
  THRESHOLDS: { LOSS_WARN, LOSS_BAD, JITTER_WARN, JITTER_BAD, Z_WARN, MIN_BASELINE, STALE_MS, LAT_MIN_DELTA_MS, LAT_MIN_FRACTION },
};
