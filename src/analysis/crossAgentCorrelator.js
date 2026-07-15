'use strict';

// Cross-agent pattern correlator. The per-target correlator (correlator.js) links
// findings WITHIN one agent/target; this one links findings ACROSS agents that
// fire close together in time, so a fault hitting several agents at once surfaces
// as ONE incident cluster with a suspected common cause instead of N look-alike
// findings. Everything stays local + explainable: time clustering + a weighted
// signal score, no ML.
//
//   const cx = createCrossAgentCorrelator();               // 5-min window
//   const clusters = cx.detect(findings, { siteOf });      // siteOf(hostId)->siteId|null
//   // -> [{ memberFindingIds, hostIds, confidence, signals, site, commonType,
//   //       severity, detectedAt, suspectedCommonCause }, ...]
//
// Matching signals (weighted, in the spirit of the L2-loop-style confidence in
// investigation/locator.js):
//   1. TIME proximity — findings from >=2 DISTINCT agents within `windowMs`.
//   2. TOPOLOGY proximity — those agents share a site (agents.location_id). This is
//      the only cross-agent adjacency BlueEye has today; subnet/VLAN/LLDP are not
//      reported by agents (see docs/cross-agent-correlation.md). A missing/`null`
//      site is treated as "no topology signal", never faked.
//   3. TYPE similarity — >=2 members share the same finding-type (metric).
//
// Confidence tiers (exactly as specified):
//   time alone ......................... low
//   time + topology .................... medium
//   time + topology + same type ........ high
// A same-type-but-different-site cluster stays low: medium/high require topology.

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const CONFIDENCE_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });
const SEVERITY_RANK = { INFO: 0, WARN: 1, CRIT: 2 };

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

function createCrossAgentCorrelator({ windowMs = DEFAULT_WINDOW_MS } = {}) {
  const minutes = Math.max(1, Math.round(windowMs / 60000));

  // Buckets findings into fixed windows across ALL hosts: sorted by time, a bucket
  // spans at most windowMs from its earliest member (same rule as correlator.js,
  // but not partitioned by host). Findings without an id or hostId are dropped.
  function timeBuckets(findings) {
    const usable = (Array.isArray(findings) ? findings : []).filter(
      (f) => f && f.id && f.hostId != null && f.metric,
    );
    const sorted = usable.slice().sort((a, b) => toTime(a) - toTime(b));
    const buckets = [];
    let cur = [];
    let anchor = null;
    for (const f of sorted) {
      const t = toTime(f);
      if (anchor === null) { anchor = t; cur.push(f); }
      else if (t - anchor <= windowMs) { cur.push(f); }
      else { buckets.push(cur); cur = [f]; anchor = t; }
    }
    if (cur.length) buckets.push(cur);
    return buckets;
  }

  // Assembles a cluster record from a set of member findings + the signals that
  // fired. `site` is the shared site id when topology fired, else null; `commonType`
  // is the shared metric when type fired, else null.
  function makeCluster(members, { topology, site = null, commonType = null }) {
    const type = commonType != null;
    let confidence = 'low';
    if (topology && type) confidence = 'high';
    else if (topology) confidence = 'medium';

    const hostIds = [...distinctHosts(members)];
    const metrics = [...new Set(members.map((f) => f.metric))];
    const cause = suspectedCause({ confidence, count: hostIds.length, commonType, metrics });
    return {
      memberFindingIds: members.map((f) => f.id),
      hostIds,
      confidence,
      signals: { time: true, topology: Boolean(topology), type },
      site: topology ? site : null,
      commonType: type ? commonType : null,
      severity: maxSeverity(members),
      detectedAt: new Date(Math.max(...members.map(toTime))),
      suspectedCommonCause: cause,
    };
  }

  // Explainable, template-free hint that names the real agent count + metric(s).
  function suspectedCause({ confidence, count, commonType, metrics }) {
    if (confidence === 'high') {
      return `${count} agents at the same site reported ${commonType} within ${minutes} min `
        + '— likely a common cause on that site (e.g. a shared uplink, switch or power event). '
        + 'Investigate the site-level dependency first.';
    }
    if (confidence === 'medium') {
      return `${count} agents at the same site reported anomalies (${metrics.join(', ')}) within ${minutes} min `
        + '— likely a site-level common cause rather than N independent faults.';
    }
    if (commonType) {
      return `${count} agents across different sites reported ${commonType} within ${minutes} min `
        + '— possible shared upstream cause; no common site to point at.';
    }
    return `${count} agents reported anomalies within ${minutes} min — weak time-only correlation, low confidence.`;
  }

  // Detects cross-agent clusters. Returns [] unless at least one bucket holds
  // findings from >=2 distinct agents. Within each such bucket it peels off, in
  // order of decreasing confidence:
  //   1. per-site groups with >=2 distinct agents  -> topology cluster (medium/high),
  //   2. per-metric groups with >=2 distinct agents -> type-only cluster (low),
  //   3. any remaining >=2-distinct-agent leftover  -> time-only cluster (low).
  // A finding lands in at most one cluster (strongest signal wins).
  function detect(findings, { siteOf = () => null } = {}) {
    const clusters = [];
    for (const bucket of timeBuckets(findings)) {
      if (distinctHosts(bucket).size < 2) continue; // no cross-agent time proximity
      const consumed = new Set();

      // 1. Topology: group by shared, non-null site.
      const bySite = new Map();
      for (const f of bucket) {
        const site = siteOf(f.hostId);
        if (site == null || site === '') continue;
        const key = String(site);
        if (!bySite.has(key)) bySite.set(key, { site, list: [] });
        bySite.get(key).list.push(f);
      }
      for (const { site, list } of bySite.values()) {
        if (distinctHosts(list).size < 2) continue;
        list.forEach((f) => consumed.add(f.id));
        const commonType = sharedMetric(list);
        clusters.push(makeCluster(list, { topology: true, site, commonType }));
      }

      // 2. Type-only: group the remainder by metric.
      const remainder = bucket.filter((f) => !consumed.has(f.id));
      const byMetric = new Map();
      for (const f of remainder) {
        if (!byMetric.has(f.metric)) byMetric.set(f.metric, []);
        byMetric.get(f.metric).push(f);
      }
      for (const [metric, list] of byMetric) {
        if (distinctHosts(list).size < 2) continue;
        list.forEach((f) => consumed.add(f.id));
        clusters.push(makeCluster(list, { topology: false, commonType: metric }));
      }

      // 3. Time-only leftover.
      const leftover = bucket.filter((f) => !consumed.has(f.id));
      if (distinctHosts(leftover).size >= 2) {
        clusters.push(makeCluster(leftover, { topology: false }));
      }
    }
    return clusters;
  }

  return { detect, windowMs };
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
  sharedMetric,
  DEFAULT_WINDOW_MS,
  CONFIDENCE_RANK,
};
