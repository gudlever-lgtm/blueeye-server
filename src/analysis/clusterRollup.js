'use strict';

// Pure decision engine for cluster-level alert rollup (Fase 5). Given a lifecycle
// event, the cluster's current state and the LAST alert it sent, decides which
// single alert (if any) to fire:
//
//   opened      — the cluster's first notification (one cluster-opened alert)
//   escalation  — severity climbed since the last alert (e.g. first CRIT member);
//                 fires IMMEDIATELY, bypassing the digest window
//   update      — new members since the last alert, and the digest window elapsed
//   resolved    — the cluster resolved (one resolution alert)
//   null        — nothing to send (within the digest window, no new members)
//
// No I/O: the sweep passes the current cluster + its stored alert state and acts
// on the returned decision. Per-channel "update vs silent" is applied at the
// dispatcher (silent channels simply skip 'update' events) — kept out of here so
// the decision stays a pure function of the cluster's own state.

const RANK = { INFO: 1, WARN: 2, CRIT: 3 };
const DEFAULT_DIGEST_MS = 10 * 60 * 1000; // "at most every N minutes", default 10

function rank(sev) { return RANK[String(sev || '').toUpperCase()] || 0; }
function ms(v) { const t = v ? new Date(v).getTime() : NaN; return Number.isNaN(t) ? null : t; }

// event: 'opened' | 'updated' | 'resolved'
// cluster: { severity, memberCount }
// prev:    { alertLastAt, alertLastSeverity, alertMemberCount } (nulls before first alert)
// opts:    { digestMs, now() }
function decideAlert(event, cluster, prev = {}, { digestMs = DEFAULT_DIGEST_MS, now = () => Date.now() } = {}) {
  if (event === 'resolved') return { kind: 'resolved', reason: 'cluster resolved' };

  const neverAlerted = prev == null || prev.alertLastAt == null;
  if (event === 'opened' || neverAlerted) {
    // First-ever notification for this cluster.
    return { kind: 'opened', reason: 'first cluster alert' };
  }

  // From here: event === 'updated' and the cluster has alerted before.
  const curRank = rank(cluster && cluster.severity);
  const prevRank = rank(prev.alertLastSeverity);
  if (curRank > prevRank) {
    return { kind: 'escalation', reason: `severity ${prev.alertLastSeverity || 'n/a'} → ${cluster.severity}` };
  }

  const newMembers = (cluster.memberCount || 0) - (prev.alertMemberCount || 0);
  if (newMembers <= 0) return { kind: null, reason: 'no new members' };

  const last = ms(prev.alertLastAt);
  if (last != null && now() - last < digestMs) {
    return { kind: null, reason: 'within digest window' };
  }
  return { kind: 'update', reason: `${newMembers} new member(s) since last update` };
}

// Human, evidence-first one-liner for the alert body — names the real counts.
function summarize(kind, cluster, prev = {}) {
  const agents = cluster && cluster.agentCount != null ? cluster.agentCount : (cluster && cluster.memberCount) || 0;
  const conf = cluster && cluster.confidence ? `${cluster.confidence} confidence` : '';
  const cls = cluster && cluster.classification ? `, suspected ${cluster.classification}` : '';
  if (kind === 'opened') return `Cross-agent incident opened — ${agents} affected agent(s), ${conf}${cls}.`;
  if (kind === 'escalation') return `Incident escalated — severity now ${cluster.severity} across ${agents} agent(s).`;
  if (kind === 'update') {
    const added = (cluster.memberCount || 0) - (prev.alertMemberCount || 0);
    return `Incident update — ${added} new member finding(s); ${agents} affected agent(s).`;
  }
  if (kind === 'resolved') {
    const dur = cluster && cluster.durationText ? ` after ${cluster.durationText}` : '';
    const note = cluster && cluster.resolutionNote ? ` — ${cluster.resolutionNote}` : '';
    return `Cross-agent incident resolved${dur}${note}.`;
  }
  return 'Cross-agent incident.';
}

module.exports = { decideAlert, summarize, DEFAULT_DIGEST_MS, RANK };
