'use strict';

const { buildTargetTimeline } = require('./targetTimeline');

// Orchestrates the per-target timeline: fetches each source independently and
// merges them via the pure buildTargetTimeline read-model.
//
// PARTIAL-FAILURE POLICY (Phase 1 decision): the sources are independent — and
// three of them (findings, incidents, audit_events) are classified TELEMETRY
// and destined for a SEPARATE database (TimescaleDB) per the storage-split
// audit. One source failing must NOT blank the whole timeline. So we fan out
// with Promise.allSettled: fulfilled sources are merged, and any rejected source
// is reported in `failedSources` with `partial: true`. A hard failure only
// happens BEFORE fan-out (e.g. resolving the target itself) — that surfaces as a
// 500 in the route; an unknown target is a 404. This mirrors the codebase's
// best-effort ingest/analysis ethos (pipelines swallow per-item failures).
//
// Target identity note (see the Phase 1 audit): every source keys off the
// agent's numeric id, but stored inconsistently — `String(id)` for findings'
// `host_id` and incident_cases' `host_id`, numeric for incidents' `agent_id` and
// audit_events' `actor_id`. This service centralises that mapping in ONE place.

// Agent lifecycle actions that belong on the timeline (connect/disconnect/enrol).
// Whitelisted at the SQL layer so recurring activity never crowds out the limit.
const AGENT_LIFECYCLE_ACTIONS = ['agent.online', 'agent.offline', 'agent.enrolled'];

function createTargetTimelineService({
  findingStore,
  incidentsRepo,
  auditEventsRepo,
  remediationPlaybooksRepo,
} = {}) {
  // --- per-source fetchers (each rejects on its own backend failure) ---------

  // Anomaly findings for the host, bounded by BOTH `from` and `to` in SQL (the
  // upper bound prevents historical-window truncation — see FindingStore.list).
  async function fetchFindings(agentId, { from, to, limit }) {
    if (!findingStore || typeof findingStore.list !== 'function') return [];
    return findingStore.list(String(agentId), from, limit, to);
  }

  // Probe-outage incidents overlapping the window for this agent.
  async function fetchIncidents(agentId, { from, to, limit }) {
    if (!incidentsRepo || typeof incidentsRepo.listForAgent !== 'function') return [];
    return incidentsRepo.listForAgent(agentId, { from, to, limit });
  }

  // Agent lifecycle events (connect/disconnect/enrol) from the unified audit
  // trail, keyed by actor (actor_type='agent', actor_id=<agent id>).
  async function fetchAgentEvents(agentId, { from, to, limit }) {
    if (!auditEventsRepo || typeof auditEventsRepo.findByActor !== 'function') return [];
    return auditEventsRepo.findByActor({
      actorType: 'agent', actorId: agentId, actions: AGENT_LIFECYCLE_ACTIONS, from, to, limit,
    });
  }

  // Remediation playbook runs for the host — one JOIN through incident_cases
  // (playbook runs are not host-keyed directly). No N+1.
  async function fetchPlaybookRuns(agentId, { from, to, limit }) {
    if (!remediationPlaybooksRepo || typeof remediationPlaybooksRepo.listRunsForHost !== 'function') return [];
    return remediationPlaybooksRepo.listRunsForHost(String(agentId), { from, to, limit });
  }

  // Fans out all sources; merges the ones that succeed; flags any that failed.
  async function getTimeline(agentId, { from = null, to = null, limit = 500 } = {}) {
    const sources = [
      ['findings', fetchFindings],
      ['incidents', fetchIncidents],
      ['agentEvents', fetchAgentEvents],
      ['playbookRuns', fetchPlaybookRuns],
    ];

    const settled = await Promise.allSettled(
      sources.map(([, fn]) => fn(agentId, { from, to, limit }))
    );

    const merged = { findings: [], incidents: [], agentEvents: [], playbookRuns: [] };
    const failedSources = [];
    settled.forEach((res, idx) => {
      const [name] = sources[idx];
      if (res.status === 'fulfilled') merged[name] = Array.isArray(res.value) ? res.value : [];
      else failedSources.push(name);
    });

    const events = buildTargetTimeline({ ...merged, limit });
    return { events, partial: failedSources.length > 0, failedSources };
  }

  return { getTimeline };
}

module.exports = { createTargetTimelineService };
