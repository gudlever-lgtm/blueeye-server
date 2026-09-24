'use strict';

const crypto = require('crypto');
const net = require('net');
const { Severity, FindingKind } = require('./constants');
const { computeAgentHealth } = require('../health/probeHealth');
const { extractAsPath, diffAsPath } = require('./asPath');
const { median } = require('./baselines');
const { evaluateMtuFindings } = require('./mtuFindings');
const { describeFailures, describeDhcp } = require('./probeFailure');

// TLS-certificate expiry thresholds (days). A site can be perfectly reachable
// while its certificate is about to lapse, so this is judged independently of
// the reachability/latency verdict below.
const CERT_WARN_DAYS = 14;
const CERT_CRIT_DAYS = 3;

// Turns one agent's recent active-probe rows into Finding objects, ready for the
// finding store. Pure + explainable: the reachability/loss/latency/jitter
// findings reuse the SAME median+MAD verdict the fleet-health view shows
// (src/health/probeHealth.js), so a finding never says anything the dashboard
// verdict doesn't. Each finding mirrors the detector's shape (id / hostId /
// metric / severity / kind / observed / baseline / deviation / explanation /
// evidence / window / createdAt).
//
//   evaluateProbeFindings(agentId, rowsNewestFirst, { now, geoProvider }) -> Finding[]
//
// `rows` must be this agent's recent rows, newest-first (as computeAgentHealth
// expects). Only warn/bad/down verdicts produce findings; ok/stale/unknown don't.
// `geoProvider` (optional) enables AS-path change findings — it maps traceroute hop
// IPs to ASNs; without it that check is skipped (everything else is unaffected).
function evaluateProbeFindings(agentId, rows, { now = () => new Date(), geoProvider = null } = {}) {
  const at = now();
  const hostId = String(agentId);
  const out = [];

  // The DHCP test is judged on its own terms below, never by the reachability
  // verdict: it broadcasts on the segment rather than probing a target, and
  // "no DHCP server answered" read as "1/5 targets not responding (e.g. eth0)"
  // would name an interface as if it were a host that went down.
  const health = computeAgentHealth(rows.filter((r) => !r || r.type !== 'dhcp'), { now: at.getTime() });
  // WHY each failed dns/tcp target failed (src/analysis/probeFailure.js), read
  // from the same newest rows the verdict above was formed from.
  const failures = describeFailures(rows);
  // Severity per evidence row, not per agent: a latency warning stays a WARN
  // even when another target on the same agent is unreachable.
  for (const ev of health.evidence) {
    const severity = severityOf(ev.level);
    if (severity) out.push(buildFinding({ hostId, at, severity, ev, health, failures }));
  }

  for (const c of certFindings(hostId, rows, at)) out.push(c);
  for (const c of asPathFindings(hostId, rows, at, geoProvider)) out.push(c);
  // Path-MTU verdicts are judged on their own terms, not against the
  // median+MAD health model above: a blackhole is a fact about packet SIZE, and
  // the loss/latency statistics that drive every other finding here are
  // measured with small packets that sail straight through it.
  for (const c of evaluateMtuFindings(hostId, rows, at)) out.push(c);
  for (const c of dhcpFindings(hostId, rows, at)) out.push(c);
  return out;
}

// DHCP findings, from the newest MEASURED dhcp row per interface (a test that
// could not run carries no offers list and is skipped, not read as silence).
//
//   no offer         → probe.dhcp.no_offer. WARN on one silent test, CRIT once
//                      two in a row heard nothing: one lost broadcast is a
//                      thing that happens, two is a server that is not there.
//   several servers  → probe.dhcp.rogue, WARN. The count is a fact, not a
//                      statistic, so no baseline is involved; the finding names
//                      every server identifier and what each one offered.
function dhcpFindings(hostId, rows, at) {
  const out = [];
  const byTarget = new Map();
  for (const r of rows) { // newest-first
    if (!r || r.type !== 'dhcp' || !r.dhcp || !Array.isArray(r.dhcp.offers)) continue;
    const list = byTarget.get(r.target) || [];
    list.push(r);
    byTarget.set(r.target, list);
  }
  for (const [target, list] of byTarget) {
    const d = describeDhcp(list[0]);
    if (!d) continue;
    const window = [new Date(at.getTime() - 60000), at];
    if (d.kind === 'no_offer') {
      let silent = 0;
      for (const r of list) { if (r.dhcp.offers.length === 0) silent += 1; else break; }
      out.push({
        id: crypto.randomUUID(),
        hostId,
        metric: 'probe.dhcp.no_offer',
        severity: silent >= 2 ? Severity.CRIT : Severity.WARN,
        kind: FindingKind.THRESHOLD,
        observed: 0,
        baseline: 1,
        deviation: null,
        window,
        explanation: `${d.text}.${silent >= 2 ? ` ${silent} tests in a row heard nothing.` : ''}`,
        evidence: [{
          metric: 'reachability', type: 'dhcp', target, iface: d.iface,
          timeoutMs: d.timeoutMs, offers: 0, consecutiveSilent: silent, ts: at.toISOString(),
        }],
        correlatedWith: [],
        createdAt: at,
        acked: false,
      });
    } else if (d.kind === 'multiple_servers') {
      out.push({
        id: crypto.randomUUID(),
        hostId,
        metric: 'probe.dhcp.rogue',
        severity: Severity.WARN,
        kind: FindingKind.THRESHOLD,
        observed: d.serverCount,
        baseline: 1,
        deviation: null,
        window,
        explanation: `${d.text}.`,
        evidence: [{
          metric: 'dhcp_servers', type: 'dhcp', target, iface: d.iface,
          serverCount: d.serverCount, serverIds: d.serverIds,
          offers: d.offers.map((o) => ({ serverId: o.serverId, offeredIp: o.offeredIp, router: o.router, relay: o.relay })),
          ts: at.toISOString(),
        }],
        correlatedWith: [],
        createdAt: at,
        acked: false,
      });
    }
  }
  return out;
}

function severityOf(level) {
  if (level === 'warn') return Severity.WARN;
  if (level === 'bad' || level === 'down') return Severity.CRIT;
  return null;
}

// Maps a single verdict evidence row to a finding.
function buildFinding({ hostId, at, severity, ev, health, failures = [] }) {
  const kind = ev.metric === 'latency' ? FindingKind.ANOMALY : FindingKind.THRESHOLD;
  const observed = ev.metric === 'loss' ? ev.lossPct
    : ev.metric === 'latency' ? ev.rttMs
      : ev.metric === 'jitter' ? ev.jitterMs
        : ev.metric === 'reachability' ? (ev.unreachable ?? null)
          : null;
  const baseline = ev.metric === 'latency' ? (ev.baselineMs ?? null) : null;
  const deviation = ev.metric === 'latency' ? (ev.z ?? null) : null;
  return {
    id: crypto.randomUUID(),
    hostId,
    metric: `probe.${ev.metric}`,
    severity,
    kind,
    observed: observed ?? null,
    baseline,
    deviation,
    window: [new Date(at.getTime() - 60000), at],
    explanation: explain(ev, health, failures),
    evidence: [{ ...ev, ...failureEvidence(ev, failures), ts: at.toISOString() }],
    correlatedWith: [],
    createdAt: at,
    acked: false,
  };
}

// A concrete, human-readable explanation per signal (real numbers, no
// placeholders) — same wording the fleet-health reason line uses.
function explain(ev, health, failures = []) {
  const to = ev.target ? ` to ${ev.target}` : '';
  if (ev.metric === 'reachability') {
    const head = `${health.metrics.unreachable}/${health.metrics.targets} probe target(s) not responding (e.g. ${ev.target}).`;
    return head + explainFailures(ev, failures);
  }
  if (ev.metric === 'loss') return `Packet loss ${ev.lossPct}%${to}.`;
  if (ev.metric === 'latency') return `Latency ${ev.rttMs} ms${to} — ~${ev.baselineMs} ms normal (z=${ev.z}).`;
  if (ev.metric === 'jitter') return `Jitter ${ev.jitterMs} ms${to}.`;
  return health.reason || 'Probe health degraded.';
}

// How many failed dns/tcp targets are spelled out in one reachability finding.
// The finding names one target; the rest are listed so an ACL that blocks three
// ports is one sentence, not three findings — but capped, because a paragraph
// nobody reads is not an explanation.
const MAX_FAILURES_EXPLAINED = 3;

// The "why" clause of a reachability finding: the evidence target first (it is
// the one the finding is keyed on), then the other failed dns/tcp targets.
// Empty when no dns/tcp target failed (only ping/trace targets down), so that
// sentence reads exactly as it always did. A failed row from an older agent
// that reported no code is still listed, and says so — "we do not know why" is
// worth reading next to one that does.
function explainFailures(ev, failures) {
  if (!failures.length) return '';
  const own = failures.find((f) => f.type === ev.type && f.target === ev.target);
  const rest = failures.filter((f) => f !== own);
  const list = (own ? [own] : []).concat(rest).slice(0, MAX_FAILURES_EXPLAINED);
  const more = failures.length - list.length;
  return ` ${list.map((f) => `${f.text}.`).join(' ')}${more > 0 ? ` (+${more} more failed dns/tcp target(s))` : ''}`;
}

// The same facts as structured evidence, for the evidence panel and for a rule
// that wants to key on them: what kind of failure the named target had, which
// resolver was asked, and whether ICMP to the same host still worked.
function failureEvidence(ev, failures) {
  if (ev.metric !== 'reachability' || !failures.length) return {};
  const own = failures.find((f) => f.type === ev.type && f.target === ev.target) || null;
  return {
    failure: own ? own.kind : null,
    errorCode: own ? own.code : null,
    resolver: own ? own.resolver : null,
    icmpOk: own ? own.icmpOk : null,
    failures: failures.slice(0, MAX_FAILURES_EXPLAINED).map((f) => ({
      type: f.type, target: f.target, failure: f.kind, errorCode: f.code, resolver: f.resolver, icmpOk: f.icmpOk,
    })),
  };
}

// Certificate findings from the newest row per target that carries a reading.
//
// Two probes produce one: `http` reads an expiry as a side effect of fetching a
// URL, and `tls` (agent 0.27+) asks the port directly — which is the only one
// that reaches a certificate on 465, 993 or 636. They are read together and
// deduplicated per target, so a host checked both ways raises one finding.
//
// Expiry is a COUNTDOWN and the other faults are already true, so they are
// separate findings rather than one "bad certificate": a chain that does not
// validate or a name that does not match is wrong now, at any expiry date.
// WHY a TLS handshake produced no certificate, in words, from the error the
// agent reported (node's own code, kept verbatim in `detail`). The common ones
// are named because each has a different fix; anything else is quoted as is.
function describeHandshake(error) {
  const text = String(error || '').trim();
  const code = (/\b(ERR_[A-Z0-9_]+|E[A-Z]{3,}[A-Z_]*)\b/.exec(text) || [])[1] || null;
  let why;
  if (/no certificate presented/i.test(text)) why = 'the handshake completed but the port presented no certificate';
  else if (/WRONG_VERSION_NUMBER|wrong version number|packet length too long|http request/i.test(text)) {
    why = 'the port answered, but not with TLS — most likely a plain-text service (such as HTTP) on this port';
  } else if (code === 'ECONNREFUSED') why = 'nothing is listening on the port (connection refused)';
  else if (code === 'ECONNRESET') why = 'the connection was reset during the handshake';
  else if (code === 'ETIMEDOUT' || /timeout/i.test(text)) why = 'no answer within the timeout';
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') why = 'the name did not resolve';
  else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') why = 'the host is not reachable from this agent';
  else if (/handshake failure|alert/i.test(text)) why = 'the server refused the handshake (no protocol or cipher in common)';
  else why = 'the handshake failed';
  return { code, why, error: text || null };
}

function handshakeFinding(hostId, r, rows, at) {
  const error = r.detail || r.execError || r.error || null;
  const d = describeHandshake(error);
  // How many of the newest rows for this target failed the same way: one
  // miss is a warning, a run of them is the service being unreachable.
  let failed = 0;
  for (const x of rows) {
    if (!x || x.type !== 'tls' || x.target !== r.target) continue;
    if (x.ok === false && !x.tls) failed += 1; else break;
  }
  return {
    id: crypto.randomUUID(),
    hostId,
    metric: 'probe.tls.handshake',
    severity: failed >= 2 ? Severity.CRIT : Severity.WARN,
    kind: FindingKind.THRESHOLD,
    observed: null,
    baseline: null,
    deviation: null,
    window: [new Date(at.getTime() - 60000), at],
    explanation: `TLS handshake with ${r.target} failed: ${d.why}${d.error ? ` (${d.error})` : ''}.`
      + `${failed >= 2 ? ` ${failed} checks in a row.` : ''} No certificate was received, so nothing is known about one.`,
    evidence: [{
      metric: 'reachability', type: 'tls', target: r.target, errorCode: d.code, error: d.error,
      consecutiveFailures: failed, ts: at.toISOString(),
    }],
    correlatedWith: [],
    createdAt: at,
    acked: false,
  };
}

// Did the certificate's CHAIN validate, apart from its name? The agent says
// so itself from 0.40 (`chainTrusted`). For an older agent's row it is read
// from node's verdict: node checks the chain before the name, so a handshake
// refused only with ERR_TLS_CERT_ALTNAME_INVALID had a chain that validated —
// reading `authorized: false` alone reported the wrong virtual host as an
// untrusted chain, and sent the operator to install an intermediate.
const TLS_NAME_ERROR_RE = /ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate's altnames/i;
function chainTrustedOf(t) {
  if (typeof t.chainTrusted === 'boolean') return t.chainTrusted;
  return t.authorized === true || TLS_NAME_ERROR_RE.test(String(t.authorizationError || ''));
}

// A tls target is `host:port`, or `name@host:port` when the probe asked for an
// explicit SNI name other than its host (agent 0.40+) — which is what keeps
// two names on one address two findings instead of one that flips between
// them. The address is the part after the `@`.
function tlsAddressOf(target) {
  const s = String(target || '');
  const i = s.lastIndexOf('@');
  return i >= 0 ? s.slice(i + 1) : s;
}

// The NAME a certificate was checked against: the SNI name the agent reports,
// else the one in the target, else the target's host when that is a name. An
// IP has no name to be valid for (null), and saying "not valid for 10.0.0.5"
// would name the wrong thing.
function tlsNameOf(t, target) {
  if (t && t.servername) return String(t.servername);
  const s = String(target || '');
  const i = s.lastIndexOf('@');
  if (i > 0) return s.slice(0, i);
  const host = s.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host && net.isIP(host) === 0 ? host : null;
}

function certFindings(hostId, rows, at) {
  const out = [];
  const seen = new Set();
  const seenState = new Set();
  for (const r of rows) { // newest-first
    // No certificate at all: the handshake failed, or finished without one.
    // That is a fact about reaching the service over TLS, with the error
    // named — never a verdict about a certificate nobody was shown.
    if (r.type === 'tls' && !r.tls && r.ok === false && !seenState.has(r.target)) {
      seenState.add(r.target);
      out.push(handshakeFinding(hostId, r, rows, at));
      continue;
    }
    if (r.type === 'tls' && r.tls && !seenState.has(r.target)) {
      seenState.add(r.target);
      const t = r.tls;
      const chainTrusted = chainTrustedOf(t);
      const address = tlsAddressOf(r.target);
      const name = tlsNameOf(t, r.target);
      const nameLabel = name || 'the name asked for';
      // What is WRONG with it, as opposed to how long it has left. Each reason
      // is named, because the three have different fixes: reissue for the name,
      // install the intermediate for the chain, renew for the expiry.
      const reasons = [];
      const faults = [];
      if (t.expired) { reasons.push('it has expired'); faults.push('expired'); }
      if (t.notYetValid) { reasons.push('it is not valid yet'); faults.push('notYetValid'); }
      if (t.hostnameMatches === false) { reasons.push(`it is not valid for ${nameLabel}`); faults.push('name'); }
      if (!chainTrusted && !t.expired) {
        reasons.push(t.selfSigned ? 'the chain is self-signed' : `the chain does not validate (${t.authorizationError || 'unknown reason'})`);
        faults.push('chain');
      }
      // A name mismatch on a chain that validates is its own sentence: the
      // certificate is fine, it is just not for this name — the wrong virtual
      // host, or a certificate that needs reissuing with the name in it.
      const nameOnly = faults.length === 1 && faults[0] === 'name';
      const sans = Array.isArray(t.altNames) && t.altNames.length
        ? ` (it is issued for ${t.altNames.slice(0, 4).map((n) => String(n).replace(/^DNS:/i, '')).join(', ')}${t.altNames.length > 4 ? ', …' : ''})`
        : (t.subject ? ` (it is issued for ${t.subject})` : '');
      if (reasons.length) {
        out.push({
          id: crypto.randomUUID(),
          hostId,
          metric: 'probe.tls',
          severity: Severity.CRIT,
          kind: FindingKind.THRESHOLD,
          observed: null,
          baseline: null,
          deviation: null,
          window: [new Date(at.getTime() - 60000), at],
          explanation: nameOnly
            ? `TLS certificate on ${address} is not valid for ${nameLabel}: the chain validates, but the certificate is not for that name${sans}. `
              + `Either ${nameLabel} points at the wrong host, or the certificate must be reissued to include it.`
            : `TLS certificate on ${address}${name && name !== address.replace(/:\d+$/, '') ? ` for ${name}` : ''} cannot be trusted: ${reasons.join('; ')}.`,
          evidence: [{
            metric: 'cert', type: 'tls', target: r.target,
            servername: t.servername || null, faults,
            authorized: t.authorized, chainTrusted, authorizationError: t.authorizationError || null,
            hostnameMatches: t.hostnameMatches,
            expired: t.expired, issuer: t.issuer, subject: t.subject,
            ts: at.toISOString(),
          }],
          correlatedWith: [],
          createdAt: at,
          acked: false,
        });
      }
    }
    if ((r.type !== 'http' && r.type !== 'tls') || seen.has(r.target)) continue;
    seen.add(r.target);
    const days = r.certExpiryDays;
    if (days == null || !Number.isFinite(days)) continue;
    const severity = days <= CERT_CRIT_DAYS ? Severity.CRIT : days <= CERT_WARN_DAYS ? Severity.WARN : null;
    if (!severity) continue;
    out.push({
      id: crypto.randomUUID(),
      hostId,
      metric: 'probe.cert',
      severity,
      kind: FindingKind.THRESHOLD,
      observed: days,
      baseline: CERT_WARN_DAYS,
      deviation: null,
      window: [new Date(at.getTime() - 60000), at],
      explanation: days <= 0
        ? `TLS certificate for ${r.target} has expired.`
        : `TLS certificate for ${r.target} expires in ${days} day(s).`,
      evidence: [{ metric: 'cert', type: r.type, target: r.target, certExpiryDays: days, ts: at.toISOString() }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    });
  }
  return out;
}

// AS-path change findings. For each traceroute target, compares the observed
// (forwarding) AS-path of the two most recent runs (rows are newest-first) and
// raises a finding when the ordered AS sequence changed. A different
// destination/origin AS is the strongest signal (WARN); other reroutes are INFO.
// Needs a geoProvider to map hop IPs to ASNs; without one it yields nothing. The
// pipeline's per-(metric,target) cooldown means a sustained new path is reported
// once, not on every probe — the same way the loss/latency findings behave.
// How many traceroute runs per target are read when measuring what a reroute did
// to the latency. Bounded: this runs on every ingest, and a median over the last
// two dozen runs is already a stable number.
const ASPATH_RTT_WINDOW = 24;

// A latency shift only counts as "the reroute cost something" when it is BOTH
// relatively and absolutely material. 15 ms on a 12 ms path is a different event
// from 15 ms on a 400 ms path, and neither threshold alone says so.
const RTT_SHIFT_PCT = 0.25;
const RTT_SHIFT_MS = 10;

// What the reroute did to the round-trip time.
//
// This is the "performance baseline" half of a path change: "the path changed"
// is a fact an operator can do nothing with, while "the path changed and latency
// went from 24 ms to 91 ms" names the cost and decides whether anyone should
// care tonight.
//
// The two sides are NOT symmetric, and pretending otherwise would be a lie about
// the data. A path change is detected on the tick it happens, so at that moment
// there is exactly ONE run on the new path and a whole window of runs on the old
// one. So:
//
//   before — the MEDIAN of the runs on the old path. This is where the noise
//            protection is needed and where it is available: a single slow
//            historical sample must not become the baseline the change is
//            judged against (CLAUDE.md: robust statistics, median not mean).
//   after  — however many runs are already on the new path, usually one.
//
// Which is why `samplesAfter` is carried into the explanation rather than hidden:
// "latency rose from 24 ms to 91 ms (median of 1 run on the new path vs 12 on the
// old)" is an honest sentence, and the thresholds below are what stop that single
// sample from escalating a severity on its own.
//
// Runs are attributed to a path by their own observed AS-path, so a flap back
// and forth does not smear the two populations together.
function rttAcrossPathChange(runs, { prevSequence, curSequence, geoProvider }) {
  const key = (seq) => (seq || []).join('>');
  const prevKey = key(prevSequence);
  const curKey = key(curSequence);
  const before = [];
  const after = [];

  for (const r of runs) {
    const rtt = r && (r.rttMs != null ? r.rttMs : r.rtt_ms);
    if (!Number.isFinite(rtt)) continue;
    const seq = key(extractAsPath(r.hops, { geoProvider }).sequence);
    if (seq === curKey) after.push(rtt);
    else if (seq === prevKey) before.push(rtt);
  }
  if (!before.length || !after.length) return null;

  const beforeMs = median(before);
  const afterMs = median(after);
  if (!Number.isFinite(beforeMs) || !Number.isFinite(afterMs)) return null;

  const deltaMs = afterMs - beforeMs;
  const ratio = beforeMs > 0 ? Math.abs(deltaMs) / beforeMs : Infinity;
  const material = Math.abs(deltaMs) >= RTT_SHIFT_MS && ratio >= RTT_SHIFT_PCT;

  return {
    beforeMs: Math.round(beforeMs * 10) / 10,
    afterMs: Math.round(afterMs * 10) / 10,
    deltaMs: Math.round(deltaMs * 10) / 10,
    samplesBefore: before.length,
    samplesAfter: after.length,
    material,
    // Only a WORSE path is worth waking someone for; a reroute that made things
    // faster is reported at the severity it would have had anyway.
    worse: material && deltaMs > 0,
  };
}

function asPathFindings(hostId, rows, at, geoProvider) {
  if (!geoProvider || typeof geoProvider.lookup !== 'function') return [];
  // Every recent traceroute per target, not just the newest two: the newest two
  // decide WHETHER the path changed, the rest measure what it cost.
  const byTarget = new Map();
  for (const r of rows) { // newest-first
    if (!r || r.type !== 'traceroute' || !Array.isArray(r.hops)) continue;
    const list = byTarget.get(r.target) || [];
    if (list.length < ASPATH_RTT_WINDOW) { list.push(r); byTarget.set(r.target, list); }
  }
  const out = [];
  for (const [target, list] of byTarget) {
    if (list.length < 2) continue; // need a previous run to compare against
    const cur = extractAsPath(list[0].hops, { geoProvider });
    const prev = extractAsPath(list[1].hops, { geoProvider });
    if (cur.length === 0 || prev.length === 0) continue; // no public ASNs to compare
    const d = diffAsPath(prev.sequence, cur.sequence);
    if (!d.changed) continue;

    const rtt = rttAcrossPathChange(list, {
      prevSequence: prev.sequence, curSequence: cur.sequence, geoProvider,
    });
    // A reroute that measurably hurt is a WARN even when the origin AS is
    // unchanged — that is the case the old severity rule could not see, because
    // it only ever looked at the control plane.
    const severity = (d.originChanged || (rtt && rtt.worse)) ? Severity.WARN : Severity.INFO;

    out.push({
      id: crypto.randomUUID(),
      hostId,
      metric: 'probe.aspath',
      severity,
      kind: FindingKind.ANOMALY, // a deviation from the previously observed path
      // The latency is the number a human reads, so it is what `observed` and
      // `baseline` carry when it is known; the AS-path lengths are the fallback.
      observed: rtt ? rtt.afterMs : cur.length,
      baseline: rtt ? rtt.beforeMs : prev.length,
      deviation: rtt ? rtt.deltaMs : null,
      window: [new Date(at.getTime() - 60000), at],
      explanation: explainAsPath(target, prev, cur, d, rtt),
      evidence: [{
        metric: 'aspath', type: 'traceroute', target,
        prevPath: prev.sequence, curPath: cur.sequence,
        added: d.added, removed: d.removed,
        prevOrigin: d.prevOrigin, curOrigin: d.curOrigin, originChanged: d.originChanged,
        rtt,
        ts: at.toISOString(),
      }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    });
  }
  return out;
}

// Plain-language explanation of an AS-path change — real ASNs, no placeholders.
function explainAsPath(target, prev, cur, d, rtt = null) {
  const fmt = (seq) => (seq.length ? seq.map((a) => `AS${a}`).join(' → ') : '(none)');
  const tail = ` Observed AS-path now ${fmt(cur.sequence)} (was ${fmt(prev.sequence)}).`;
  const head = d.originChanged
    ? `Path to ${target} now exits via AS${d.curOrigin} (was AS${d.prevOrigin}).`
    : (() => {
      const bits = [];
      if (d.added.length) bits.push(`now transits ${d.added.map((a) => `AS${a}`).join(', ')}`);
      if (d.removed.length) bits.push(`no longer via ${d.removed.map((a) => `AS${a}`).join(', ')}`);
      if (!bits.length && d.lengthDelta !== 0) bits.push(`AS-path length ${d.lengthDelta > 0 ? `grew by ${d.lengthDelta}` : `shrank by ${-d.lengthDelta}`}`);
      return `Path to ${target} changed: ${bits.length ? bits.join('; ') : 'AS-path reordered'}.`;
    })();
  return `${head}${tail}${explainRttShift(rtt)}`;
}

// What the reroute cost, in the sentence an operator reads. Silent when the
// medians say nothing changed — "latency is unchanged" on every reroute trains
// people to stop reading the line that matters.
function explainRttShift(rtt) {
  if (!rtt) return '';
  const samples = ` (median of ${rtt.samplesAfter} run${rtt.samplesAfter === 1 ? '' : 's'} on the new path vs ${rtt.samplesBefore} on the old).`;
  if (!rtt.material) return ` Latency is unchanged at ~${rtt.afterMs} ms${samples}`;
  const direction = rtt.deltaMs > 0 ? 'rose' : 'fell';
  return ` Latency ${direction} from ${rtt.beforeMs} ms to ${rtt.afterMs} ms${samples}`;
}

module.exports = {
  evaluateProbeFindings, dhcpFindings, rttAcrossPathChange, explainRttShift,
  CERT_WARN_DAYS, CERT_CRIT_DAYS, RTT_SHIFT_PCT, RTT_SHIFT_MS, ASPATH_RTT_WINDOW,
};
