'use strict';

const { ipv4ToInt } = require('../geo/privateIp');
const { numOrNull } = require('../lib/num');

// Cross-agent pattern correlator. The per-target correlator (correlator.js) links
// findings WITHIN one agent/target; this one links findings ACROSS agents that
// fire close together in time, so a fault hitting several agents at once surfaces
// as ONE event cluster with a suspected common cause instead of N look-alike
// findings. Everything stays local + explainable: pairwise relations with a
// named reason, no ML.
//
//   const cx = createCrossAgentCorrelator();               // 5-min window
//   const clusters = cx.detect(findings, { siteOf, topology });
//   // -> [{ memberFindingIds, hostIds, confidence, signals, site, commonType,
//   //       topologySource, topologyDetail, grouping, severity, detectedAt,
//   //       firstSeenAt, suspectedCommonCause }, ...]
//
// WHAT A FINDING IS ABOUT. Grouping used to be "same 5-min bucket, then same
// site", which merged two independent faults on one site into one situation and
// left the same target failing from two sites as a weak "low" cluster. Each
// finding now has a SUBJECT (subjectOf below): the probe target it names, the
// switch or port it is about, the transaction test, or — for a finding about
// the agent itself (cpu, agent.offline, ...) — that agent plus its condition.
//
// Two findings (from any agents, within `windowMs` of each other) are related
// when, in this order:
//   1. target   — they are about the SAME subject (8.8.8.8 failing from two
//                 sites is one target problem seen twice, whatever the sites);
//   2. switch   — both are about the same switch (two ports of sw-3, or a port
//                 and the loop on it);
//   3. upstream — one is about a switch, the other comes from an agent the
//                 topology puts downstream of that switch (blast radius);
//   4. site     — both are about the AGENTS themselves (not about something
//                 the agents look at), share a site and report the same
//                 condition: N agents at one site going dark together is a
//                 site cause. The agent's site is its place in the topology; a
//                 probe target's place is unknown, so two DIFFERENT targets at
//                 one site are not related by the site alone;
//   5. lldp     — their agents are adjacent in the LLDP neighbour graph;
//   6. condition (weak) — agent-level findings with the same condition at
//                 different/unknown sites: a hint, never more than `low`.
// Anything else stays apart: two unrelated subjects on one site are two
// situations, not one.
//
// TIME. No fixed buckets: a relation needs the two findings within `windowMs`
// of EACH OTHER, and a cluster is the connected component, so it is anchored
// on its earliest member and slides forward as related findings keep arriving.
// A fault straddling a bucket boundary is no longer split in two.
//
// Confidence tiers:
//   related by target/switch/upstream/site/lldp, sharing a condition ... high
//   related by target/switch/upstream/lldp, mixed conditions ........... medium
//   weak same-condition only ............................................ low
// A cluster always spans >=2 distinct agents (it is cross-agent by definition).

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const CONFIDENCE_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });
const SEVERITY_RANK = { INFO: 0, WARN: 1, CRIT: 2 };

// Relation kinds, strongest first — the order the pairwise check tries them
// and the order a cluster names its primary reason in.
const REASON_ORDER = Object.freeze(['target', 'switch', 'upstream', 'site', 'lldp', 'condition']);
// Kinds that put the members in one place (a shared target counts: many
// vantage points agreeing on one thing is the strongest "where" there is).
const STRONG_REASONS = new Set(['target', 'switch', 'upstream', 'site', 'lldp']);

// Milliseconds for a finding, tolerant of Date or ISO string. Findings without a
// usable createdAt sort to the front (epoch) rather than throwing.
function toTime(finding) {
  const t = finding && finding.createdAt ? new Date(finding.createdAt).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// Distinct agent (host) ids present in a list of findings.
function distinctHosts(list) {
  return new Set(list.map((f) => String(f.hostId)));
}

// Highest severity string among a list (CRIT > WARN > INFO), defaulting INFO.
function maxSeverity(list) {
  return list.reduce((best, f) => {
    const s = f.severity || 'INFO';
    return (SEVERITY_RANK[s] ?? -1) > (SEVERITY_RANK[best] ?? -1) ? s : best;
  }, 'INFO');
}

// The CONDITION a finding reports, independent of which port it names: the
// port id is IN a switch-port metric (`if.12.link.down`) so baselines stay per
// port, but "link down" on port 12 and on port 40 is the same condition.
function conditionOf(finding) {
  const m = String((finding && finding.metric) || '');
  return m.replace(/^if\.\d+\./, 'if.');
}

// ---- subjects -------------------------------------------------------------

// A probe/outage target reduced to the host it names: a URL to its hostname,
// `host:port` to the host, `[v6]:port` to the v6 literal, lower-case, no
// trailing dot. `null` for nothing usable.
function normaliseTarget(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s.includes('://')) {
    try { s = new URL(s).hostname; } catch { /* keep the raw text */ }
  }
  const v6 = s.match(/^\[([0-9a-f:.]+)\](?::\d+)?$/);
  if (v6) s = v6[1];
  else if ((s.match(/:/g) || []).length === 1) s = s.replace(/:\d+$/, ''); // host:port (not a bare v6)
  s = s.replace(/\.$/, '');
  return s || null;
}

// True for a target whose NAME only means something inside one site: an
// RFC1918/loopback/link-local/CGNAT IPv4, a ULA/link-local IPv6, or a
// single-label hostname ("printer"). 10.0.0.1 at two sites is two machines.
function isSiteLocalTarget(host) {
  if (!host) return true;
  if (ipv4ToInt(host) !== null) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return !host.includes('.') || /\.(local|lan|internal|home\.arpa)$/.test(host);
}

// What a finding is ABOUT, as { kind, key, label, deviceId }. `key` is the
// normalised identity two findings must share to be "the same subject";
// `label` is how the explanation names it. Read from the finding's own
// columns first (deviceId/interfaceId, migration 110) and its first evidence
// sample second — the shapes every producer already writes:
//   probe.* / probe_outage.* ... evidence[0].target
//   transaction.* .............. evidence[0].testId
//   device.new ................. evidence[0].labels.mac, else .target (the ip)
//   l2.loop .................... deviceId
//   if.<port>.* (counters, link, duplex) ... deviceId + interfaceId
//   agent.offline, cpu, ... .... the agent itself, per condition
function subjectOf(finding, { siteOf = () => null } = {}) {
  const f = finding || {};
  const ev = Array.isArray(f.evidence) && f.evidence[0] && typeof f.evidence[0] === 'object' ? f.evidence[0] : {};
  const labels = ev.labels && typeof ev.labels === 'object' ? ev.labels : {};
  const host = String(f.hostId);
  const metric = String(f.metric || '');
  // numOrNull, not Number(): an absent id must stay absent, never become 0.
  const deviceId = numOrNull(f.deviceId ?? ev.deviceId ?? null);
  const interfaceId = numOrNull(f.interfaceId ?? ev.interfaceId ?? null);

  if (deviceId != null) {
    const dev = labels.device || `device ${deviceId}`;
    if (interfaceId != null) {
      return {
        kind: 'port', key: `port:${deviceId}/${interfaceId}`, deviceId,
        deviceLabel: dev, label: `${dev} ${labels.iface || `interface ${interfaceId}`}`,
      };
    }
    return { kind: 'device', key: `device:${deviceId}`, deviceId, deviceLabel: dev, label: dev };
  }

  if (metric.startsWith('transaction.') && ev.testId != null) {
    return {
      kind: 'transaction', key: `transaction:${ev.testId}`, deviceId: null,
      label: ev.testName ? `transaction test "${ev.testName}"` : `transaction test ${ev.testId}`,
    };
  }

  if (metric === 'device.new' && labels.mac) {
    const mac = String(labels.mac).toLowerCase();
    return { kind: 'target', key: `mac:${mac}`, deviceId: null, label: `device ${mac}` };
  }

  const rawTarget = metric === 'agent.offline' ? null : (ev.target ?? labels.target ?? null);
  const target = normaliseTarget(rawTarget);
  if (target && !/^agent:/.test(target)) {
    if (isSiteLocalTarget(target)) {
      // Only the same NAME at the same site is the same machine; with no known
      // site, only the same agent can vouch for that.
      const site = siteOf(f.hostId);
      const scope = site != null && site !== '' ? `site:${site}` : `agent:${host}`;
      return { kind: 'target', key: `target:${scope}@${target}`, deviceId: null, label: target };
    }
    return { kind: 'target', key: `target:${target}`, deviceId: null, label: target };
  }

  // About the agent itself. The condition is part of the identity: cpu and
  // disk on one agent are two things, not one.
  return { kind: 'agent', key: `agent:${host}:${conditionOf(f)}`, deviceId: null, label: `agent ${host}` };
}

// ---- union-find -------------------------------------------------------------

function unionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
    return r;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  return { find, union };
}

function createCrossAgentCorrelator({ windowMs = DEFAULT_WINDOW_MS } = {}) {
  const minutes = Math.max(1, Math.round(windowMs / 60000));

  // The relation between two findings, or null. `ctx` carries the per-sweep
  // lookups (sites, LLDP, downstream sets) and a cache for the agent pairs.
  function relate(a, b, ctx) {
    const sa = a.subject;
    const sb = b.subject;
    const crossHost = a.host !== b.host;

    if (sa.key === sb.key) {
      return { kind: 'target', detail: sa.label, subject: sa.key };
    }
    if (sa.deviceId != null && sa.deviceId === sb.deviceId) {
      return { kind: 'switch', detail: ctx.deviceLabel(sa.deviceId, sa), subject: `device:${sa.deviceId}` };
    }
    const up = upstreamOf(a, b, ctx) || upstreamOf(b, a, ctx);
    if (up) return up;
    if (!crossHost) return null;

    const sameCondition = a.condition === b.condition;
    if (sa.kind === 'agent' && sb.kind === 'agent' && sameCondition
        && a.site != null && a.site === b.site) {
      return { kind: 'site', detail: `site ${a.site}`, site: a.site };
    }
    const lldp = ctx.lldp(a.host, b.host);
    if (lldp) return { kind: 'lldp', detail: lldp.detail || null };
    if (sa.kind === 'agent' && sb.kind === 'agent' && sameCondition) {
      return { kind: 'condition', detail: a.condition };
    }
    return null;
  }

  // `sw` is about a switch that the topology puts upstream of the agent that
  // reported `other`.
  function upstreamOf(sw, other, ctx) {
    if (sw.subject.deviceId == null || other.subject.deviceId != null) return null;
    const down = ctx.downstreamOf(sw.subject.deviceId);
    if (!down || !down.has(other.host)) return null;
    return {
      kind: 'upstream',
      detail: `${ctx.deviceLabel(sw.subject.deviceId, sw.subject)} is upstream of agent ${other.host}`,
    };
  }

  function makeContext(siteOf, topology) {
    const lldpCache = new Map();
    const downCache = new Map();
    const topo = topology || {};
    return {
      lldp(h1, h2) {
        if (typeof topo.related !== 'function') return null;
        const k = h1 < h2 ? `${h1}|${h2}` : `${h2}|${h1}`;
        if (!lldpCache.has(k)) {
          let rel = null;
          try { rel = topo.related(h1, h2); } catch { rel = null; }
          lldpCache.set(k, rel && rel.related ? rel : null);
        }
        return lldpCache.get(k);
      },
      downstreamOf(deviceId) {
        if (typeof topo.downstreamOf !== 'function') return null;
        if (!downCache.has(deviceId)) {
          let set = null;
          try {
            const r = topo.downstreamOf(deviceId);
            set = r ? new Set([...r].map(String)) : null;
          } catch { set = null; }
          downCache.set(deviceId, set);
        }
        return downCache.get(deviceId);
      },
      deviceLabel(deviceId, subject) {
        if (typeof topo.deviceLabel === 'function') {
          try { const l = topo.deviceLabel(deviceId); if (l) return l; } catch { /* fall through */ }
        }
        return (subject && subject.deviceLabel) || `switch ${deviceId}`;
      },
      siteOf,
    };
  }

  // Assembles a cluster record from its member nodes and the reasons (edges)
  // that joined them.
  function makeCluster(nodes, edges) {
    const members = nodes.map((n) => n.finding);
    const hostIds = [...distinctHosts(members)];
    // Only a reason that connects two DIFFERENT agents or two different
    // subjects explains the grouping; an agent repeating itself does not.
    const byKind = new Map();
    for (const e of edges) {
      if (!e.explains) continue;
      if (!byKind.has(e.kind)) byKind.set(e.kind, new Map());
      const details = byKind.get(e.kind);
      const d = e.detail || '';
      details.set(d, (details.get(d) || new Set()));
      e.hosts.forEach((h) => details.get(d).add(h));
    }
    const reasons = [];
    for (const kind of REASON_ORDER) {
      if (!byKind.has(kind)) continue;
      for (const [detail, hosts] of byKind.get(kind)) reasons.push({ kind, detail: detail || null, agents: hosts.size });
    }
    const strong = reasons.some((r) => STRONG_REASONS.has(r.kind));
    const commonType = sharedMetric(members.map((f) => ({ metric: conditionOf(f), hostId: f.hostId })));
    let confidence = 'low';
    if (strong && commonType != null) confidence = 'high';
    else if (strong) confidence = 'medium';

    const primary = reasons.find((r) => STRONG_REASONS.has(r.kind)) || null;
    const sites = new Set(nodes.map((n) => n.site));
    const site = sites.size === 1 ? [...sites][0] : null;
    const metrics = [...new Set(members.map((f) => f.metric))];
    const subjects = [...new Set(nodes.map((n) => n.subject.key))];
    const why = reasons.map(reasonText);
    const cause = suspectedCause({
      confidence, count: hostIds.length, commonType, metrics, primary, siteCount: sites.size, why,
    });
    const times = members.map(toTime);
    return {
      memberFindingIds: members.map((f) => f.id),
      hostIds,
      confidence,
      signals: { time: true, topology: strong, type: commonType != null },
      site: strong ? site : null,
      topologySource: primary ? primary.kind : null,
      topologyDetail: primary ? primary.detail : null,
      commonType,
      grouping: { subjects, reasons, why },
      severity: maxSeverity(members),
      firstSeenAt: new Date(Math.min(...times)),
      detectedAt: new Date(Math.max(...times)),
      suspectedCommonCause: cause,
    };
  }

  // One line per reason — the WHY the cluster carries.
  function reasonText(r) {
    const n = r.agents;
    switch (r.kind) {
      case 'target': return `shared target: ${r.detail} (seen by ${n} agent${n === 1 ? '' : 's'})`;
      case 'switch': return `same switch: ${r.detail}`;
      case 'upstream': return `upstream: ${r.detail}`;
      case 'site': return `same condition at the same site (${r.detail}, ${n} agents)`;
      case 'lldp': return `LLDP neighbours${r.detail ? `: ${r.detail}` : ''}`;
      default: return `same condition (${r.detail}) at unrelated sites — time proximity only`;
    }
  }

  // Explainable, template-free hint that names the real agent count + metric(s) +
  // which relation drove the grouping.
  function suspectedCause({ confidence, count, commonType, metrics, primary, siteCount, why }) {
    const basis = why.length ? ` Grouped because: ${why.join('; ')}.` : '';
    const kind = primary ? primary.kind : null;
    if (kind === 'target') {
      const from = siteCount > 1 ? ` from ${siteCount} sites` : '';
      return `${count} agents${from} reported ${commonType || metrics.join(', ')} about ${primary.detail} within ${minutes} min `
        + '— the target itself (or the path to it) is the likely cause, not the agents.' + basis;
    }
    if (kind === 'switch' || kind === 'upstream') {
      return `${count} agents reported ${commonType || metrics.join(', ')} within ${minutes} min around ${primary.detail} `
        + '— likely a fault on that switch. Investigate it first.' + basis;
    }
    if (kind === 'lldp') {
      const via = primary.detail ? ` (${primary.detail})` : '';
      if (confidence === 'high') {
        return `${count} agents adjacent in the LLDP neighbor graph${via} reported ${commonType} within ${minutes} min `
          + '— likely a shared L2 segment/switch cause. Investigate the common neighbor first.' + basis;
      }
      return `${count} agents adjacent in the LLDP neighbor graph${via} reported anomalies (${metrics.join(', ')}) within ${minutes} min `
        + '— likely a shared L2 topology cause rather than N independent faults.' + basis;
    }
    if (kind === 'site') {
      return `${count} agents at the same site reported ${commonType} within ${minutes} min `
        + '— likely a common cause on that site (e.g. a shared uplink, switch or power event). '
        + 'Investigate the site-level dependency first.' + basis;
    }
    if (commonType) {
      return `${count} agents across different sites reported ${commonType} within ${minutes} min `
        + '— possible shared upstream cause; no common site to point at.' + basis;
    }
    return `${count} agents reported anomalies within ${minutes} min — weak time-only correlation, low confidence.` + basis;
  }

  // Detects cross-agent clusters: every pair of findings within `windowMs` of
  // each other is tested for a relation (above); related findings are joined
  // and each connected component spanning >=2 distinct agents is a cluster.
  // A finding lands in at most one cluster.
  function detect(findings, { siteOf = () => null, topology = null } = {}) {
    const usable = (Array.isArray(findings) ? findings : []).filter(
      (f) => f && f.id && f.hostId != null && f.metric,
    );
    if (distinctHosts(usable).size < 2) return [];
    const ctx = makeContext(siteOf, topology);
    const nodes = usable
      .map((f) => {
        const site = siteOf(f.hostId);
        return {
          finding: f,
          host: String(f.hostId),
          t: toTime(f),
          site: site == null || site === '' ? null : String(site),
          condition: conditionOf(f),
          subject: subjectOf(f, { siteOf }),
        };
      })
      .sort((a, b) => a.t - b.t);

    const uf = unionFind(nodes.length);
    const edges = [];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length && nodes[j].t - nodes[i].t <= windowMs; j += 1) {
        const rel = relate(nodes[i], nodes[j], ctx);
        if (!rel) continue;
        uf.union(i, j);
        edges.push({
          i, j, kind: rel.kind, detail: rel.detail,
          explains: nodes[i].host !== nodes[j].host || nodes[i].subject.key !== nodes[j].subject.key,
          hosts: [nodes[i].host, nodes[j].host],
        });
      }
    }

    const comps = new Map();
    nodes.forEach((n, i) => {
      const r = uf.find(i);
      if (!comps.has(r)) comps.set(r, { nodes: [], edges: [] });
      comps.get(r).nodes.push(n);
    });
    for (const e of edges) comps.get(uf.find(e.i)).edges.push(e);

    const clusters = [];
    for (const { nodes: members, edges: es } of comps.values()) {
      if (distinctHosts(members.map((n) => n.finding)).size < 2) continue;
      clusters.push(makeCluster(members, es));
    }
    // Earliest situation first, like the old bucket order.
    clusters.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    return clusters;
  }

  return { detect, windowMs };
}

// Per-signal weights for the explainable confidence breakdown, in the spirit of
// the L2-loop multi-signal weighting (investigation/locator.js): more independent
// signal types → higher confidence that this is ONE event. `time` is the base
// signal (always present in a cluster); topology + type are the corroborating ones.
// "topology" is the WHERE signal: a shared target, a shared switch, an upstream
// switch, a shared site or an LLDP adjacency.
const SIGNAL_WEIGHTS = Object.freeze({ time: 0.4, topology: 0.35, type: 0.25 });
// Single-signal (time-only) baseline — what a cluster scores on time proximity alone.
const SINGLE_SIGNAL_BASELINE = SIGNAL_WEIGHTS.time;

// Explainable confidence breakdown for a stored cluster: which signals drove the
// grouping, each signal's weight, the summed score and how it compares to the
// single-signal (time-only) baseline. The signals are re-derived from the stored
// tier + the member findings (topology is the only thing that lifts a cluster
// above `low`; a shared finding-type is recomputable from the members), so this
// never needs the signals persisted on the row. When the stored grouping
// basis (migration 130) is passed, its reasons are named in the explanation.
function confidenceBreakdown(confidence, members = [], grouping = null) {
  const topology = confidence === 'medium' || confidence === 'high';
  const list = Array.isArray(members) ? members : [];
  const type = sharedMetric(list.map((f) => ({ metric: conditionOf(f), hostId: f.hostId }))) != null;
  const signals = { time: true, topology, type };

  const contributing = [];
  let score = 0;
  for (const key of Object.keys(SIGNAL_WEIGHTS)) {
    if (signals[key]) { score += SIGNAL_WEIGHTS[key]; contributing.push({ signal: key, weight: SIGNAL_WEIGHTS[key] }); }
  }
  score = Number(score.toFixed(2));

  const names = contributing.map((c) => c.signal).join(' + ');
  const why = grouping && Array.isArray(grouping.why) && grouping.why.length ? ` Grouped because: ${grouping.why.join('; ')}.` : '';
  return {
    tier: confidence,
    score,
    baseline: SINGLE_SIGNAL_BASELINE,
    aboveBaseline: score > SINGLE_SIGNAL_BASELINE,
    signals,
    weights: SIGNAL_WEIGHTS,
    contributing,
    reasons: grouping && Array.isArray(grouping.reasons) ? grouping.reasons : [],
    explanation: `${contributing.length} independent signal(s) — ${names} — score ${score.toFixed(2)} `
      + `vs single-signal baseline ${SINGLE_SIGNAL_BASELINE.toFixed(2)}.${why}`,
  };
}

// Groups findings whose agents are LLDP-adjacent (per the topology resolver) into
// connected components. Returns [{ list, detail }] for each component spanning >=2
// distinct agents; `detail` is a representative adjacency string for the evidence.
// Union-find over the agents present; a pair is only unioned when the resolver
// says related (missing edges stay separate = "unknown", never forced together).
// (Kept for callers that want the agent-level components; detect() applies the
// same relation pairwise, per finding.)
function lldpComponents(findings, topology) {
  const byAgent = new Map();
  for (const f of findings) {
    const h = String(f.hostId);
    if (!byAgent.has(h)) byAgent.set(h, []);
    byAgent.get(h).push(f);
  }
  const agents = [...byAgent.keys()];
  if (agents.length < 2) return [];

  const idx = new Map(agents.map((a, i) => [a, i]));
  const uf = unionFind(agents.length);
  const detailByPair = [];

  for (let i = 0; i < agents.length; i += 1) {
    for (let j = i + 1; j < agents.length; j += 1) {
      const rel = topology.related(agents[i], agents[j]);
      if (rel && rel.related) {
        uf.union(i, j);
        detailByPair.push({ a: agents[i], detail: rel.detail || null });
      }
    }
  }

  const comps = new Map();
  for (const a of agents) {
    const r = uf.find(idx.get(a));
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(a);
  }

  const out = [];
  for (const [root, compAgents] of comps) {
    if (compAgents.length < 2) continue;
    const list = compAgents.flatMap((a) => byAgent.get(a));
    const d = detailByPair.find((p) => uf.find(idx.get(p.a)) === root && p.detail);
    out.push({ list, detail: d ? d.detail : null });
  }
  return out;
}

// The metric shared by >=2 distinct agents in a list, or null. When several
// metrics qualify, the one with the widest agent spread wins (ties: first seen).
function sharedMetric(list) {
  const byMetric = new Map();
  for (const f of list) {
    if (!byMetric.has(f.metric)) byMetric.set(f.metric, new Set());
    byMetric.get(f.metric).add(String(f.hostId));
  }
  let best = null;
  let bestSpread = 1;
  for (const [metric, hosts] of byMetric) {
    if (hosts.size >= 2 && hosts.size > bestSpread) { best = metric; bestSpread = hosts.size; }
  }
  return best;
}

module.exports = {
  createCrossAgentCorrelator,
  subjectOf,
  normaliseTarget,
  isSiteLocalTarget,
  conditionOf,
  sharedMetric,
  lldpComponents,
  confidenceBreakdown,
  SIGNAL_WEIGHTS,
  SINGLE_SIGNAL_BASELINE,
  DEFAULT_WINDOW_MS,
  CONFIDENCE_RANK,
  REASON_ORDER,
};
