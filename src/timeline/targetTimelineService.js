'use strict';

const { buildTargetTimeline } = require('./targetTimeline');
const { severityBand } = require('../devices/deviceEventCatalog');

// Orchestrates the per-target timeline: fetches each source independently and
// merges them via the pure buildTargetTimeline read-model.
//
// PARTIAL-FAILURE POLICY (Phase 1 decision): the sources are independent — and
// three of them (findings, events, audit_events) are classified TELEMETRY
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
// `host_id` and event_cases' `host_id`, numeric for events' `agent_id` and
// audit_events' `actor_id`. This service centralises that mapping in ONE place.

// Agent lifecycle actions that belong on the timeline (connect/disconnect/enrol).
// Whitelisted at the SQL layer so recurring activity never crowds out the limit.
const AGENT_LIFECYCLE_ACTIONS = ['agent.online', 'agent.offline', 'agent.enrolled'];

function createTargetTimelineService({
  findingStore,
  probeOutagesRepo,
  auditEventsRepo,
  remediationPlaybooksRepo,
  topologyChangesRepo,
  deviceEventsRepo = null,
} = {}) {
  // --- per-source fetchers (each rejects on its own backend failure) ---------

  // Anomaly findings for the host, bounded by BOTH `from` and `to` in SQL (the
  // upper bound prevents historical-window truncation — see FindingStore.list).
  async function fetchFindings(agentId, { from, to, limit }) {
    if (!findingStore || typeof findingStore.list !== 'function') return [];
    return findingStore.list(String(agentId), from, limit, to);
  }

  // Probe outages overlapping the window for this agent.
  async function fetchProbeOutages(agentId, { from, to, limit }) {
    if (!probeOutagesRepo || typeof probeOutagesRepo.listForAgent !== 'function') return [];
    return probeOutagesRepo.listForAgent(agentId, { from, to, limit });
  }

  // Agent lifecycle events (connect/disconnect/enrol) from the unified audit
  // trail, keyed by actor (actor_type='agent', actor_id=<agent id>).
  async function fetchAgentEvents(agentId, { from, to, limit }) {
    if (!auditEventsRepo || typeof auditEventsRepo.findByActor !== 'function') return [];
    return auditEventsRepo.findByActor({
      actorType: 'agent', actorId: agentId, actions: AGENT_LIFECYCLE_ACTIONS, from, to, limit,
    });
  }

  // Remediation playbook runs for the host — one JOIN through event_cases
  // (playbook runs are not host-keyed directly). No N+1.
  async function fetchPlaybookRuns(agentId, { from, to, limit }) {
    if (!remediationPlaybooksRepo || typeof remediationPlaybooksRepo.listRunsForHost !== 'function') return [];
    return remediationPlaybooksRepo.listRunsForHost(String(agentId), { from, to, limit });
  }

  // Recorded LLDP topology changes (topology_changes) for this agent.
  async function fetchTopologyChanges(agentId, { from, to, limit }) {
    if (!topologyChangesRepo || typeof topologyChangesRepo.listForAgent !== 'function') return [];
    return topologyChangesRepo.listForAgent({ agentId, from, to, limit });
  }

  // What the device itself said in the window (device_events, migration 103).
  // Keyed on device_id — the agent row the sender RESOLVED to — not on the
  // agent that received the line, because the timeline is about the equipment.
  // Events from an unresolved sender have device_id NULL and correctly appear
  // on nobody's timeline; they are still readable in the device log.
  async function fetchDeviceEvents(agentId, { from, to, limit }) {
    if (!deviceEventsRepo || typeof deviceEventsRepo.listForDevice !== 'function') return [];
    return deviceEventsRepo.listForDevice(agentId, { from, to, limit });
  }

  // Fans out all sources; merges the ones that succeed; flags any that failed.
  async function getTimeline(agentId, { from = null, to = null, limit = 500 } = {}) {
    const sources = [
      ['findings', fetchFindings],
      ['probeOutages', fetchProbeOutages],
      ['agentEvents', fetchAgentEvents],
      ['playbookRuns', fetchPlaybookRuns],
      ['topologyChanges', fetchTopologyChanges],
      ['deviceEvents', fetchDeviceEvents],
    ];

    const settled = await Promise.allSettled(
      sources.map(([, fn]) => fn(agentId, { from, to, limit }))
    );

    const merged = { findings: [], probeOutages: [], agentEvents: [], playbookRuns: [], topologyChanges: [], deviceEvents: [] };
    const failedSources = [];
    settled.forEach((res, idx) => {
      const [name] = sources[idx];
      if (res.status === 'fulfilled') merged[name] = Array.isArray(res.value) ? res.value : [];
      else failedSources.push(name);
    });

    const events = buildTargetTimeline({ ...merged, severityBand, limit });
    return { events, partial: failedSources.length > 0, failedSources };
  }

  return { getTimeline };
}

module.exports = { createTargetTimelineService };
