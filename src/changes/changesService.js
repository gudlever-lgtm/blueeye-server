'use strict';

const {
  buildChangeFeed,
  fromAgentEvents,
  fromFindings,
  fromProbeIncidents,
  fromIncidentCases,
  fromClusters,
  fromTopologyChanges,
  fromInterfaceTransitions,
  fromPlaybookRuns,
  fromConfigSnapshots,
  agentHealthRows,
} = require('./changeFeed');

// Fan-out for the changes landing page (Fase 2).
//
// Fetches every source independently and merges them through the pure
// buildChangeFeed read-model. Partial-failure policy is the same as
// targetTimelineService and searchService: the sources are independent, and one
// of them being down must not blank the page a shift starts on. A failed source
// is named in `failedSources` with `partial: true`.
//
// The one genuinely fatal failure is loading the agent list — it happens before
// the fan-out and every mapper uses it for labels, so that surfaces as a 500.

// Agent lifecycle actions that belong on the feed. Whitelisted at the SQL layer
// so the fleet's continuous reporting activity never crowds out the limit.
const AGENT_LIFECYCLE_ACTIONS = ['agent.online', 'agent.offline', 'agent.enrolled'];

// How long an agent may stay silent before the feed calls its heartbeat stale.
const DEFAULT_HEARTBEAT_STALE_MS = 15 * 60 * 1000;

// Per-source row ceiling. Generous, but bounded: a fleet reconnecting after a
// WAN blip can produce thousands of agent.online rows, and one noisy source must
// not be able to push every other source's events off the page.
const PER_SOURCE_LIMIT = 500;

function createChangesService({
  agentsRepo,
  auditEventsRepo = null,
  findingStore = null,
  incidentsRepo = null,
  incidentCasesRepo = null,
  incidentClustersRepo = null,
  topologyChangesRepo = null,
  interfaceStatesRepo = null,
  remediationPlaybooksRepo = null,
  configSnapshotsRepo = null,
  serverAgentVersion = null,
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS,
  logger = null,
} = {}) {
  // --- per-source fetchers (each rejects on its own backend failure) ---------

  async function fetchAgentEvents({ from, to }, ctx) {
    if (!auditEventsRepo || typeof auditEventsRepo.findByActor !== 'function') return [];
    // findByActor with no actorId is a fleet-wide query scoped to agents, with
    // the action whitelist applied in SQL.
    const rows = await auditEventsRepo.findByActor({
      actorType: 'agent', actions: AGENT_LIFECYCLE_ACTIONS, from, to, limit: PER_SOURCE_LIMIT,
    });
    return fromAgentEvents(rows, ctx);
  }

  async function fetchFindings({ from, to }, ctx) {
    if (!findingStore || typeof findingStore.list !== 'function') return [];
    // hostId null = fleet-wide (buildFilter only adds the clause when set).
    const rows = await findingStore.list(null, from, PER_SOURCE_LIMIT, to);
    return fromFindings(rows, ctx);
  }

  async function fetchProbeIncidents({ from, to }, ctx) {
    if (!incidentsRepo || typeof incidentsRepo.list !== 'function') return [];
    const rows = await incidentsRepo.list({ from, to, limit: PER_SOURCE_LIMIT });
    // The repo returns incidents OVERLAPPING the window; the mapper decides which
    // of the open/resolve transitions actually fell inside it.
    return fromProbeIncidents(rows, { from, to, ...ctx });
  }

  async function fetchIncidentCases({ from, to }) {
    if (!incidentCasesRepo || typeof incidentCasesRepo.list !== 'function') return [];
    return fromIncidentCases(await incidentCasesRepo.list({ from, to, limit: PER_SOURCE_LIMIT }));
  }

  async function fetchClusters({ from, to }) {
    if (!incidentClustersRepo || typeof incidentClustersRepo.list !== 'function') return [];
    return fromClusters(await incidentClustersRepo.list({ from, to, limit: PER_SOURCE_LIMIT }));
  }

  async function fetchTopologyChanges({ from, to }) {
    if (!topologyChangesRepo || typeof topologyChangesRepo.list !== 'function') return [];
    return fromTopologyChanges(await topologyChangesRepo.list({ from, to, limit: PER_SOURCE_LIMIT }));
  }

  async function fetchInterfaceTransitions({ from, to }, ctx) {
    if (!interfaceStatesRepo || typeof interfaceStatesRepo.list !== 'function') return [];
    return fromInterfaceTransitions(await interfaceStatesRepo.list({ from, to, limit: PER_SOURCE_LIMIT }), ctx);
  }

  async function fetchPlaybookRuns({ from, to }) {
    if (!remediationPlaybooksRepo || typeof remediationPlaybooksRepo.listRunsBetween !== 'function') return [];
    return fromPlaybookRuns(await remediationPlaybooksRepo.listRunsBetween({ from, to, limit: PER_SOURCE_LIMIT }));
  }

  async function fetchConfigSnapshots({ from, to }, ctx) {
    if (!configSnapshotsRepo || typeof configSnapshotsRepo.listBetween !== 'function') return [];
    return fromConfigSnapshots(await configSnapshotsRepo.listBetween({ from, to, limit: PER_SOURCE_LIMIT }), ctx);
  }

  // --- fan-out ---------------------------------------------------------------

  // Returns
  //   { since, until, groups[], events[], total, returned, offset, truncated,
  //     partial, failedSources[] }
  async function changesSince({ from, to = new Date(), limit = 200, offset = 0 } = {}) {
    const agents = (await agentsRepo.findAll()) || []; // fatal on failure — see above
    const nameById = new Map(agents.map((a) => [Number(a.id), a.display_name || a.hostname || `agent ${a.id}`]));
    const ctx = { nameFor: (id) => nameById.get(Number(id)) || `agent ${id}` };
    const window = { from, to };

    const sources = [
      ['agents', () => fetchAgentEvents(window, ctx)],
      ['findings', () => fetchFindings(window, ctx)],
      ['incidents', () => fetchProbeIncidents(window, ctx)],
      ['incident_cases', () => fetchIncidentCases(window)],
      ['clusters', () => fetchClusters(window)],
      ['topology', () => fetchTopologyChanges(window)],
      ['interfaces', () => fetchInterfaceTransitions(window, ctx)],
      ['playbooks', () => fetchPlaybookRuns(window)],
      ['config', () => fetchConfigSnapshots(window, ctx)],
    ];

    const settled = await Promise.allSettled(sources.map(([, run]) => run()));

    const events = [];
    const failedSources = [];
    settled.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        events.push(...(Array.isArray(res.value) ? res.value : []));
      } else {
        failedSources.push(sources[i][0]);
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`changes: source "${sources[i][0]}" failed (${res.reason && res.reason.message})`);
        }
      }
    });

    // Current-state rows are derived from the agent list already in hand, so
    // they cannot fail independently and are not a fan-out source.
    events.push(...agentHealthRows(agents, {
      now: to,
      serverAgentVersion,
      heartbeatStaleMs,
    }));

    const feed = buildChangeFeed(events, { from, to, limit, offset });
    return { ...feed, partial: failedSources.length > 0, failedSources };
  }

  return { changesSince };
}

module.exports = { createChangesService, AGENT_LIFECYCLE_ACTIONS, PER_SOURCE_LIMIT, DEFAULT_HEARTBEAT_STALE_MS };
