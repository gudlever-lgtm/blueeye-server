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

const { subnetKey } = require('./addr');

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
  // A member of an ECMP group that answered in the earlier runs and has gone
  // quiet while loss rose (ecmpAnalysis in src/analysis/pathGraph.js). The
  // missing address IS the evidence, so it is a fact of its own.
  'traceroute.lost_member_count', 'traceroute.lost_member_hop', 'traceroute.lost_member_ips',
  'traceroute.lost_member_explain',
  // The other protocol probes.
  'dns.ok', 'dns.rtt_ms', 'dns.loss_pct',
  'http.ok', 'http.status', 'http.rtt_ms',
  'tcp.ok', 'tcp.rtt_ms', 'tcp.loss_pct',
  // Why a TCP connect failed, as the agent classified it (0.33+): 'refused',
  // 'timeout', 'unreachable', 'error'. The distinction a filter finding stands
  // on — a reset is the host answering, a timeout is a packet dropped in
  // silence — so it is a fact in its own right and not a detail string.
  'tcp.failure',
  // One namespace per port asked for, so a playbook can read ICMP against ONE
  // application port. Without this a rule could only say "some TCP probe
  // failed", which is not what "ping works but 443 does not" means.
  'tcp.port_*.ok', 'tcp.port_*.rtt_ms', 'tcp.port_*.failure', 'tcp.port_*.loss_pct',
  // The certificate (agent 0.27+, the two halves apart since 0.40). `ok` is the
  // whole verdict; the rest is what made it.
  'tls.ok', 'tls.rtt_ms', 'tls.expiry_days', 'tls.expired',
  'tls.chain_trusted', 'tls.hostname_matches', 'tls.protocol',
  // The interface the agent sits behind.
  'iface.err_per_sec', 'iface.drop_per_sec', 'iface.util_pct', 'iface.speed_mbps',
  'iface.link_down', 'iface.busy_port_count',
  // Late collisions — the counter that NAMES a duplex mismatch rather than
  // merely being consistent with one. SNMP only (EtherLike-MIB), so it is
  // absent far more often than it is zero, and the two must stay apart.
  'iface.late_coll_per_sec',
  // The host NIC's own duplex and error detail (agent proc source, 0.40+):
  // `/sys/class/net/<if>/duplex` and the frame/colls/carrier columns of
  // /proc/net/dev. Absent — never 0 — wherever the source cannot read them, for
  // the same reason as late collisions: a zero is what rules a fault out.
  'iface.duplex', 'iface.collisions_per_sec', 'iface.frame_err_per_sec', 'iface.carrier_err_per_sec',
  // The same measurements taken from the FAR end, for the faults that only show
  // up when you ask the question in both directions.
  'reverse.ping.ok', 'reverse.ping.loss_pct', 'reverse.ping.rtt_ms',
  'reverse.traceroute.ok', 'reverse.traceroute.hop_count',
  'path_compare.compared', 'path_compare.same_hops',
  'path_compare.matched_hops', 'path_compare.match_ratio', 'path_compare.exact_matches',
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

// How many members answered at the widest hop of ONE run, from the per-hop
// `ips` lists. Undefined when the agent did not send the lists: an older agent
// reports one address per hop whatever the path looks like, so its "1" is not a
// measurement of a single path — reading it as one is how ECMP used to be ruled
// out on every trace.
function withinRunBranches(hops) {
  if (!hops.some((h) => h && Array.isArray(h.ips))) return undefined;
  return hops.reduce((max, h) => {
    const set = new Set([...(h && h.ip ? [h.ip] : []), ...(h && Array.isArray(h.ips) ? h.ips : [])].filter(Boolean));
    return Math.max(max, set.size);
  }, 1);
}

// A traceroute's facts. The ECMP half comes from the path graph's analysis
// (`ecmp` = ecmpAnalysis() over this run and the recent runs before it), which
// is where branches are computed — recomputing them here would be a second,
// quietly different answer to the same question. `branchCount` is the older,
// plain-number form of the same input and is still honoured.
//
// branch_count is only stated when it was MEASURED: a fork seen anywhere is a
// fork; "one path" needs either the agent's own per-hop member lists or at
// least MIN_RUNS_FOR_SINGLE_PATH earlier runs that all agreed.
const MIN_RUNS_FOR_SINGLE_PATH = 2;

function tracerouteFacts(r, { branchCount, ecmp } = {}) {
  const hops = Array.isArray(r.hops) ? r.hops : [];
  const losses = hops.map((h) => num(h && h.lossPct)).filter((v) => v !== undefined);
  const inRun = withinRunBranches(hops);
  let branches;
  let lost = {};
  if (ecmp && typeof ecmp === 'object') {
    const n = num(ecmp.branchCount);
    if (n !== undefined && (n > 1 || inRun !== undefined || (ecmp.runsCompared || 0) >= MIN_RUNS_FOR_SINGLE_PATH)) branches = n;
    if ((ecmp.runsCompared || 0) > 0) {
      const list = Array.isArray(ecmp.lostMembers) ? ecmp.lostMembers : [];
      lost = {
        // Zero is a real answer: there WAS history, and no member went missing.
        lost_member_count: list.length,
        lost_member_hop: list.length ? num(list[0].hop) : undefined,
        lost_member_ips: list.length ? list.flatMap((m) => m.missingIps || []).join(', ') : undefined,
        lost_member_explain: list.length ? list.map((m) => m.explain).join(' ') : undefined,
      };
    }
  } else {
    branches = num(branchCount) ?? inRun;
  }
  return defined({
    ok: typeof r.ok === 'boolean' ? r.ok : undefined,
    hop_count: hops.length || undefined,
    branch_count: branches,
    sustained_loss_from_hop: sustainedLossFromHop(hops),
    worst_hop_loss_pct: losses.length ? Math.max(...losses) : undefined,
    ...lost,
  });
}

const simpleFacts = (r) => defined({
  ok: typeof r.ok === 'boolean' ? r.ok : undefined,
  rtt_ms: num(r.rttMs),
  loss_pct: num(r.lossPct),
  status: num(r.status),
});

// A TCP probe's target is `host:port`, and the port is the whole point: a rule
// about a filter has to name the application port, because "ping works but TCP
// does not" is only a finding when the two are about the same destination and
// the same service. Returns the port, or null for a row that does not carry one.
function portOf(target) {
  const m = /:(\d+)$/.exec(String(target || ''));
  return m ? Number(m[1]) : null;
}

const tcpFacts = (r) => defined({
  ok: typeof r.ok === 'boolean' ? r.ok : undefined,
  rtt_ms: num(r.rttMs),
  loss_pct: num(r.lossPct),
  // Only the agent's own classification. A row an older agent wrote carries
  // none, and a rule over it then reads `unknown` — which is the honest answer
  // for "we could not tell a reset from a drop", and the one thing a filter
  // finding must never assume.
  failure: typeof r.failure === 'string' && r.failure ? r.failure : undefined,
});

const tlsFacts = (r) => {
  const t = r.tls && typeof r.tls === 'object' ? r.tls : {};
  return defined({
    ok: typeof r.ok === 'boolean' ? r.ok : undefined,
    rtt_ms: num(r.rttMs),
    expiry_days: num(r.certExpiryDays) ?? num(t.expiryDays),
    expired: typeof t.expired === 'boolean' ? t.expired : undefined,
    chain_trusted: typeof t.chainTrusted === 'boolean' ? t.chainTrusted : undefined,
    // Tri-state at the source: false is a mismatch, null is "not checked"
    // (an IP probed without SNI). Only the boolean is a measurement.
    hostname_matches: typeof t.hostnameMatches === 'boolean' ? t.hostnameMatches : undefined,
    protocol: typeof t.protocol === 'string' && t.protocol ? t.protocol : undefined,
  });
};

const SHAPERS = {
  ping: pingFacts,
  path_mtu: pathMtuFacts,
  traceroute: tracerouteFacts,
  tcptraceroute: tracerouteFacts,
  dns: simpleFacts,
  http: simpleFacts,
  tcp: tcpFacts,
  tls: tlsFacts,
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
    // 'full' | 'half' | 'unknown' — the kernel's own words. Only a string the
    // interface layer vetted gets through; anything else is "not measured".
    duplex: ['full', 'half', 'unknown'].includes(worst.duplex) ? worst.duplex : undefined,
    collisions_per_sec: num(worst.collPerSec),
    frame_err_per_sec: num(worst.frameErrPerSec),
    carrier_err_per_sec: num(worst.carrierErrPerSec),
    // How many ports are busy AT ONCE. One busy port is a file transfer; several
    // unrelated ones at the same moment is what a broadcast storm looks like from
    // the outside, and no single interface can show you that.
    busy_port_count: list.filter((i) => num(i.utilPct) !== undefined && i.utilPct >= 75).length,
  });
}

// How much of the two paths must line up before they are called "the same".
// Not 100%: a router that answers one direction and rate-limits the other, or
// one silent hop, must not turn a symmetric path into a confirmed asymmetry.
const SAME_PATH_RATIO = 0.6;

// Do the two directions traverse the same routers? Only answerable when both
// traces actually returned hops; `compared` says whether the question was even
// asked, so a rule can tell "the paths differ" from "nobody looked".
//
// WHY NOT RAW ADDRESS OVERLAP. A router answers a traceroute from the interface
// the probe ARRIVED on. Going out, router R answers from the side facing the
// origin; coming back, from the side facing the far end. So a perfectly
// symmetric path shows two DIFFERENT address lists, and comparing them address
// by address confirmed "asymmetric" on nearly every path.
//
// What this does instead, and why each step:
//   1. drops the endpoints — the far end is the forward target and the origin is
//      the reverse target; they are hosts, not routers on the path;
//   2. reverses the reverse trace, so both lists run origin → far end;
//   3. matches a hop pair when the address is the same OR both sit in the same
//      /24 (IPv4) or /64 (IPv6): the two ends of a router-to-router link are
//      numbered from one small subnet, so R's two interfaces on the link it
//      shares with its neighbour land in the same /24;
//   4. counts the longest run of matches IN ORDER (LCS), so one shared /24 at
//      each end cannot make two different middles look alike;
//   5. calls it the same path when ≥ SAME_PATH_RATIO of the shorter path's
//      hops line up.
//
// LIMITS, carried in the result as `method`: a provider numbering links from a
// shared /24 pool matches more than it should, and links numbered from
// unrelated subnets on each side match less; the forward target is assumed to
// sit at (or next to) the far-end agent — if it does not, the two traces cover
// different stretches and the comparison says so by not matching.
function comparePaths(forward, reverse) {
  const ipsOf = (r) => (r && Array.isArray(r.hops) ? r.hops : []).map((h) => h && h.ip).filter(Boolean);
  const dropEnd = (list, end) => (end && list.length && list[list.length - 1] === end ? list.slice(0, -1) : list);
  const a = dropEnd(ipsOf(forward), forward && forward.target);
  const b = dropEnd(ipsOf(reverse), reverse && reverse.target).slice().reverse();
  if (a.length === 0 || b.length === 0) return { compared: false };

  const keyOf = (ip) => subnetKey(ip);
  const match = (x, y) => x === y || (keyOf(x) !== null && keyOf(x) === keyOf(y));
  // LCS over the two ordered hop lists, with `match` as equality.
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = match(a[i - 1], b[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const matched = dp[a.length][b.length];
  const setB = new Set(b);
  const exact = a.filter((ip) => setB.has(ip)).length;
  const ratio = Math.round((matched / Math.min(a.length, b.length)) * 100) / 100;
  return {
    compared: true,
    same_hops: ratio >= SAME_PATH_RATIO,
    matched_hops: matched,
    exact_matches: exact,
    match_ratio: ratio,
    forward_hops: a.length,
    reverse_hops: b.length,
    method: `reverse trace reversed; hops matched in order by same address or same /24 (IPv4) / /64 (IPv6); same path when >= ${Math.round(SAME_PATH_RATIO * 100)}% of the shorter path lines up`,
  };
}

// Builds the fact object a playbook's rules are evaluated against.
//
//   results  — probe results from the session's own agent, newest wins
//   reverse  — the same from the far-end agent, when there is one
//   interfaces — computeInterfaceHealth() output for the session's agent
//   branchCounts — { [probeType]: n } from the path graph, for ECMP (older form)
//   ecmp     — { [probeType]: ecmpAnalysis() } from the path graph: branches
//              across this run and the recent runs, and any member that died
function buildFacts({ results = [], reverse = [], interfaces = null, branchCounts = {}, ecmp = {} } = {}) {
  const facts = {};
  const take = (rows, into) => {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || typeof r.type !== 'string') continue;
      const shape = SHAPERS[r.type];
      if (!shape) continue;
      // TCP is the one type where one namespace is not enough: a session tests
      // :80 and :443 and a rule has to be able to name one of them. Each port
      // gets `tcp.port_<n>`, and the bare `tcp.*` keys stay as the newest row,
      // so the rules written before ports existed still read what they always
      // did.
      if (r.type === 'tcp') {
        const v = shape(r, {});
        if (!hasAny(v)) continue;
        const port = portOf(r.target);
        const slot = into.tcp || (into.tcp = {});
        if (port !== null && slot[`port_${port}`] === undefined) slot[`port_${port}`] = v;
        for (const [k, val] of Object.entries(v)) if (slot[k] === undefined) slot[k] = val;
        continue;
      }
      // First result of a type wins. Callers pass newest-first, and a session
      // that ran the same probe twice means the operator re-ran it: the later
      // answer is the one they are looking at.
      if (into[r.type] !== undefined) continue;
      const v = shape(r, { branchCount: branchCounts && branchCounts[r.type], ecmp: ecmp && ecmp[r.type] });
      if (hasAny(v)) into[r.type] = v;
    }
  };
  take(results, facts);

  const rev = {};
  // The reverse direction has no history of its own here; its ECMP is not read.
  const takeReverse = (rows) => {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || typeof r.type !== 'string' || !SHAPERS[r.type] || rev[r.type] !== undefined) continue;
      const v = SHAPERS[r.type](r, {});
      if (hasAny(v)) rev[r.type] = v;
    }
  };
  takeReverse(reverse);
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

module.exports = { buildFacts, readFact, portOf, isKnownFactPath, sustainedLossFromHop, comparePaths, ifaceFacts, FACT_SCHEMA, SAME_PATH_RATIO, MIN_RUNS_FOR_SINGLE_PATH };
