'use strict';

// The facts a rule may read, and the code that builds them from test results.
//
// Two halves that must agree, so they live in one file:
//
//   FACT_SCHEMA  — every path a playbook is allowed to name. The catalogue
//                  checks rules and fix placeholders against it at startup, so a
//                  typo like `path_mtu.blackhole_detcted` fails the build
//                  instead of quietly evaluating to "unknown" forever, which is
//                  indistinguishable from "the test has not run yet" and would
//                  make a playbook permanently inconclusive with no error
//                  anywhere.
//
//   buildFacts() — turns what the probes actually reported into that shape.
//                  Pure: results in, a plain object out. No database, no clock.
//
// A value is present only when it was MEASURED. Anything else is left out
// entirely rather than defaulted to zero, because a rule reading a missing path
// returns unknown, and unknown is the honest answer for a test that did not run.
// A zero would be a lie that reads as a verdict.

// `*` is a single dynamic segment: `ping.size_*.loss_pct` covers size_64,
// size_1472 and whatever else an operator asks for.
const FACT_SCHEMA = [
  // Reachability from the agent that owns the session.
  'ping.ok', 'ping.loss_pct', 'ping.rtt_ms', 'ping.min_ms', 'ping.max_ms', 'ping.jitter_ms',
  // The don't-fragment size sweep. One namespace per payload size asked for.
  'ping.df', 'ping.size_*.loss_pct', 'ping.size_*.rtt_ms', 'ping.size_*.ok', 'ping.size_*.measured', 'ping.size_*.mtu_hint',
  // What the path will actually carry. Named as the agent names it
  // (blueeye-agent src/probes/pathmtu.js) — a field renamed in transit is a
  // field whose two names can drift apart silently.
  'path_mtu.ok', 'path_mtu.path_mtu', 'path_mtu.blackhole_detected',
  'path_mtu.icmp_frag_needed_seen', 'path_mtu.recommended_mss', 'path_mtu.mtu_drop_at_hop',
  'path_mtu.mss_observed', 'path_mtu.blackhole_hop_count',
  // Derived, not reported: is the kernel still negotiating an MSS the path
  // cannot carry? That is the direct evidence that clamping is missing, and it
  // is the difference between "the path is narrow" and "nothing told the sender".
  'path_mtu.mss_exceeds_path',
  // The path itself.
  'traceroute.ok', 'traceroute.hop_count', 'traceroute.branch_count',
  'traceroute.sustained_loss_from_hop', 'traceroute.worst_hop_loss_pct',
  // The other protocol probes.
  'dns.ok', 'dns.rtt_ms', 'dns.loss_pct',
  'http.ok', 'http.status', 'http.rtt_ms',
  'tcp.ok', 'tcp.rtt_ms', 'tcp.loss_pct',
  // The interface the agent sits behind.
  'iface.err_per_sec', 'iface.drop_per_sec', 'iface.util_pct', 'iface.speed_mbps',
  'iface.link_down', 'iface.busy_port_count',
  // Late collisions — the counter that NAMES a duplex mismatch rather than
  // merely being consistent with one. SNMP only (EtherLike-MIB), so it is
  // absent far more often than it is zero, and the two must stay apart.
  'iface.late_coll_per_sec',
  // The same measurements taken from the FAR end, for the faults that only show
  // up when you ask the question in both directions.
  'reverse.ping.ok', 'reverse.ping.loss_pct', 'reverse.ping.rtt_ms',
  'reverse.traceroute.ok', 'reverse.traceroute.hop_count',
  'path_compare.compared', 'path_compare.same_hops',
];

// Does `path` match the schema, allowing `*` to stand for one segment?
function isKnownFactPath(path) {
  const parts = String(path).split('.');
  return FACT_SCHEMA.some((pattern) => {
    const pp = pattern.split('.');
    if (pp.length !== parts.length) return false;
    return pp.every((seg, i) => (seg.endsWith('*') ? parts[i].startsWith(seg.slice(0, -1)) : seg === parts[i]));
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// What a TCP segment loses to headers before any payload: IP + TCP, 20 + 20 for
// IPv4. Used to turn a measured path MTU into the MSS the path can carry.
const MSS_HEADERS = { 4: 40, 6: 60 };
// Drops the keys that were never measured, so a rule sees "missing" rather than
// a default. Object.fromEntries on the surviving pairs keeps the call sites flat.
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
const hasAny = (obj) => Object.keys(obj).length > 0;

// --- per-probe-type shaping --------------------------------------------------

function pingFacts(r) {
  const out = defined({
    ok: typeof r.ok === 'boolean' ? r.ok : undefined,
    loss_pct: num(r.lossPct),
    rtt_ms: num(r.rttMs),
    min_ms: num(r.minMs),
    max_ms: num(r.maxMs),
    jitter_ms: num(r.jitterMs),
    df: typeof r.df === 'boolean' ? r.df : undefined,
  });
  // Each payload size gets its own namespace, named by the size so the rule
  // reads the way the operator would say it out loud.
  for (const s of Array.isArray(r.sizes) ? r.sizes : []) {
    const bytes = num(s && s.bytes);
    if (bytes === undefined) continue;
    const measured = s.measured !== false;
    out[`size_${bytes}`] = defined({
      // A size the local stack refused was not measured on the path. Reporting
      // its 100% as loss would point the diagnosis at the wrong end of the wire.
      loss_pct: measured ? num(s.lossPct) : undefined,
      rtt_ms: measured ? num(s.rttMs) : undefined,
      ok: measured ? num(s.lossPct) !== undefined && s.lossPct < 100 : undefined,
      measured,
      mtu_hint: num(s.mtuHint),
    });
  }
  return out;
}

// The path_mtu verdict. The server stores it camelCase in `probe_results.mtu`
// (migration 096 translates the agent's snake_case at that one boundary); the
// per-hop numbers ride in the ordinary `hops` column alongside the traceroute
// ones, with the latency fields null and `maxMtu`/`status` filled in.
//
// Hop statuses, and why the distinction is the whole point:
//   ok           carries what it was handed
//   reduced      narrows the path AND says so (ICMP frag-needed) — normal
//   blackhole    narrows it in silence — the one that breaks applications
//   no_response  answers no ICMP at all. NOT a fault, and never read as one
//   skipped      past the probe's time budget — reported, never dropped
function pathMtuFacts(r) {
  const m = r.mtu && typeof r.mtu === 'object' ? r.mtu : {};
  const pathMtu = num(m.pathMtu);
  const mssObserved = num(m.mssObserved);
  const hops = Array.isArray(r.hops) ? r.hops : [];
  const blackholeHop = hops.find((h) => h && h.status === 'blackhole');
  return defined({
    ok: typeof r.ok === 'boolean' ? r.ok : undefined,
    path_mtu: pathMtu,
    // Only a run that measured an MTU may state a verdict. `ok` cannot be the
    // gate: the probe reports ok:true even when it finds a blackhole, because
    // the finding is about the path and not the agent. A run with no MTU did
    // not look, and reading its `false` default as an all-clear is how a real
    // fault gets marked "ruled out".
    blackhole_detected: pathMtu != null ? m.blackholeDetected === true : undefined,
    // Did anything volunteer its MTU? A path that is small and SAYS so is a
    // different finding from one that swallows the packets.
    icmp_frag_needed_seen: pathMtu != null ? m.icmpFragNeededSeen === true : undefined,
    recommended_mss: num(m.recommendedMss),
    mtu_drop_at_hop: num(m.mtuDropAtHop) ?? (blackholeHop ? num(blackholeHop.hop) : undefined),
    mss_observed: mssObserved,
    // The kernel is still offering a segment the path will not carry. Only
    // answerable when BOTH numbers exist: `mssSupported:false` means the agent
    // could not look (it is a Linux-only read), which is not the same as
    // nothing to report, so a rule must not take the absence for an all-clear.
    mss_exceeds_path: (mssObserved != null && pathMtu != null)
      ? mssObserved > pathMtu - MSS_HEADERS[4]
      : undefined,
    // How many hops narrowed the path in silence. Zero is a real answer here —
    // it means the hops were measured and none of them was a blackhole.
    blackhole_hop_count: hops.length ? hops.filter((h) => h && h.status === 'blackhole').length : undefined,
  });
}

// Loss that starts at one hop and continues all the way to the target is real,
// and it is at that hop. Loss on a single hop in the middle that does NOT
// continue is the router rate-limiting its own ICMP replies while forwarding
// everything else perfectly — the single most common way a traceroute is
// misread. Returns the first hop index where sustained loss begins, or 0 when
// there is none.
function sustainedLossFromHop(hops, { threshold = 5 } = {}) {
  const list = Array.isArray(hops) ? hops : [];
  if (list.length === 0) return undefined;
  for (let i = 0; i < list.length; i += 1) {
    const loss = num(list[i] && list[i].lossPct);
    if (loss === undefined || loss < threshold) continue;
    // Every hop after this one must be losing too. A hop that answers cleanly
    // downstream proves the packets were getting through all along.
    const rest = list.slice(i + 1);
    const sustained = rest.every((h) => {
      const l = num(h && h.lossPct);
      return l === undefined ? false : l >= threshold;
    });
    if (sustained) return num(list[i].hop) ?? i + 1;
  }
  return 0;
}

function tracerouteFacts(r, { branchCount } = {}) {
  const hops = Array.isArray(r.hops) ? r.hops : [];
  const losses = hops.map((h) => num(h && h.lossPct)).filter((v) => v !== undefined);
  return defined({
    ok: typeof r.ok === 'boolean' ? r.ok : undefined,
    hop_count: hops.length || undefined,
    // How many parallel paths the trace saw. Supplied by the caller from the
    // path graph, which is where ECMP branches are already computed — recomputing
    // them here would be a second, quietly different answer to the same question.
    branch_count: num(branchCount),
    sustained_loss_from_hop: sustainedLossFromHop(hops),
    worst_hop_loss_pct: losses.length ? Math.max(...losses) : undefined,
  });
}

const simpleFacts = (r) => defined({
  ok: typeof r.ok === 'boolean' ? r.ok : undefined,
  rtt_ms: num(r.rttMs),
  loss_pct: num(r.lossPct),
  status: num(r.status),
});

const SHAPERS = {
  ping: pingFacts,
  path_mtu: pathMtuFacts,
  traceroute: tracerouteFacts,
  tcptraceroute: tracerouteFacts,
  dns: simpleFacts,
  http: simpleFacts,
  tcp: simpleFacts,
};

// Interface health for the agent, from the shape src/health/interfaceHealth.js
// already produces. The worst non-virtual interface is the one the rules read:
// a docker bridge with no carrier is not the operator's problem, and letting it
// into these numbers would confirm `physical_errors` on every container host in
// the fleet.
function ifaceFacts(interfaces) {
  const list = (Array.isArray(interfaces) ? interfaces : []).filter((i) => i && !i.virtual);
  if (list.length === 0) return {};
  const rank = { down: 0, bad: 1, warn: 2, ok: 3 };
  const worst = list.reduce((a, b) => ((rank[b.status] ?? 9) < (rank[a.status] ?? 9) ? b : a), list[0]);
  return defined({
    err_per_sec: num(worst.errPerSec),
    drop_per_sec: num(worst.dropPerSec),
    util_pct: num(worst.utilPct),
    speed_mbps: num(worst.speedMbps),
    link_down: typeof worst.linkDown === 'boolean' ? worst.linkDown : undefined,
    // Only present when something could actually count them. A /proc sample
    // never can and many switches do not implement the MIB; leaving it out means
    // a rule over it reads `unknown`, which is the honest answer, instead of an
    // all-clear that would rule the fault out on no evidence at all.
    late_coll_per_sec: num(worst.lateCollPerSec),
    // How many ports are busy AT ONCE. One busy port is a file transfer; several
    // unrelated ones at the same moment is what a broadcast storm looks like from
    // the outside, and no single interface can show you that.
    busy_port_count: list.filter((i) => num(i.utilPct) !== undefined && i.utilPct >= 75).length,
  });
}

// Do the two directions traverse the same hops? Only answerable when both
// traces actually returned hops; `compared` says whether the question was even
// asked, so a rule can tell "the paths differ" from "nobody looked".
function comparePaths(forward, reverse) {
  const a = (forward && Array.isArray(forward.hops) ? forward.hops : []).map((h) => h && h.ip).filter(Boolean);
  const b = (reverse && Array.isArray(reverse.hops) ? reverse.hops : []).map((h) => h && h.ip).filter(Boolean);
  if (a.length === 0 || b.length === 0) return { compared: false };
  const setB = new Set(b);
  // The reverse trace walks the path backwards, so order proves nothing; what
  // matters is whether the two directions visit the same routers at all.
  const overlap = a.filter((ip) => setB.has(ip)).length;
  return { compared: true, same_hops: overlap >= Math.min(a.length, b.length) };
}

// Builds the fact object a playbook's rules are evaluated against.
//
//   results  — probe results from the session's own agent, newest wins
//   reverse  — the same from the far-end agent, when there is one
//   interfaces — computeInterfaceHealth() output for the session's agent
//   branchCounts — { [probeType]: n } from the path graph, for ECMP
function buildFacts({ results = [], reverse = [], interfaces = null, branchCounts = {} } = {}) {
  const facts = {};
  const take = (rows, into) => {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || typeof r.type !== 'string') continue;
      const shape = SHAPERS[r.type];
      if (!shape) continue;
      // First result of a type wins. Callers pass newest-first, and a session
      // that ran the same probe twice means the operator re-ran it: the later
      // answer is the one they are looking at.
      if (into[r.type] !== undefined) continue;
      const v = shape(r, { branchCount: branchCounts[r.type] });
      if (hasAny(v)) into[r.type] = v;
    }
  };
  take(results, facts);

  const rev = {};
  take(reverse, rev);
  if (hasAny(rev)) facts.reverse = rev;

  const iface = ifaceFacts(interfaces);
  if (hasAny(iface)) facts.iface = iface;

  const forwardTrace = (Array.isArray(results) ? results : []).find((r) => r && r.type === 'traceroute');
  const reverseTrace = (Array.isArray(reverse) ? reverse : []).find((r) => r && r.type === 'traceroute');
  if (forwardTrace || reverseTrace) facts.path_compare = comparePaths(forwardTrace, reverseTrace);

  return facts;
}

// Reads a fact path out of a built fact object, for filling a fix's
// placeholders. Returns undefined when it was not measured — the caller decides
// what to say about that, because "we did not measure it" is a sentence, not a
// blank.
function readFact(facts, path) {
  let cur = facts;
  for (const part of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur === null ? undefined : cur;
}

module.exports = { buildFacts, readFact, isKnownFactPath, sustainedLossFromHop, comparePaths, ifaceFacts, FACT_SCHEMA };
