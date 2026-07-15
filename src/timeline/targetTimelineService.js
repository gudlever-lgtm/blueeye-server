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

function createTargetTimelineService({
  findingStore,
  incidentsRepo,
  auditEventsRepo,
  remediationPlaybooksRepo,
  incidentCasesRepo,
} = {}) {
  // --- per-source fetchers (each rejects on its own backend failure) ---------

  // Anomaly findings for the host. FindingStore.list takes a `since` lower
  // bound only, so we bound the upper end (`to`) in memory.
  async function fetchFindings(agentId, { from, to, limit }) {
    if (!findingStore || typeof findingStore.list !== 'function') return [];
    const rows = await findingStore.list(String(agentId), from, limit);
    const toMs = to ? new Date(to).getTime() : Infinity;
    return rows.filter((f) => {
      const t = f.createdAt ? new Date(f.createdAt).getTime() : NaN;
      return !Number.isNaN(t) && t <= toMs;
    });
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
    return auditEventsRepo.findByActor({ actorType: 'agent', actorId: agentId, from, to, limit });
  }

  // Remediation playbook runs for the host. Playbook runs are NOT agent-keyed
  // directly — they hang off incident_cases (host_id). We resolve the host's
  // cases, then their runs, then window-filter by ran_at. Reuses existing repo
  // methods (no new SQL join) — keeps the fragile string host_id join in code.
  async function fetchPlaybookRuns(agentId, { from, to, limit }) {
    if (!remediationPlaybooksRepo || typeof remediationPlaybooksRepo.listRunsForIncident !== 'function') return [];
    if (!incidentCasesRepo || typeof incidentCasesRepo.list !== 'function') return [];
    const cases = await incidentCasesRepo.list({ hostId: String(agentId), limit: 500 });
    if (!Array.isArray(cases) || cases.length === 0) return [];
    const runLists = await Promise.all(
      cases.map((c) => remediationPlaybooksRepo.listRunsForIncident(c.id, { limit }))
    );
    const fromMs = from ? new Date(from).getTime() : -Infinity;
    const toMs = to ? new Date(to).getTime() : Infinity;
    return runLists.flat().filter((r) => {
      const t = r && r.ranAt ? new Date(r.ranAt).getTime() : NaN;
      return !Number.isNaN(t) && t >= fromMs && t <= toMs;
    });
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
