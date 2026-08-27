'use strict';

const { computeBlastRadius } = require('../topology/blastRadius');
const { buildTargetTimeline } = require('../timeline/targetTimeline');
const {
  buildRootCauses,
  buildTopologyView,
  buildAnomalies,
  buildSummary,
  asArray,
  toNodeId,
} = require('./overview');
const { buildClusterDetail } = require('../analysis/clusterView');

// Fan-out for the consolidated Troubleshooting Dashboard. Reads the five
// capability domains through the interfaces they already expose and hands the
// rows to the pure read-model in overview.js. No business logic lives here.
//
// PARTIAL-FAILURE POLICY — mirrors targetTimelineService.js. The sources are
// independent, so one failing backend must cost the operator that ONE panel,
// not the whole screen. We fan out with Promise.allSettled; rejected sources are
// reported in `failedSources` with `partial: true`. Only a failure BEFORE
// fan-out surfaces as a 500.
//
// THE TWO PERFORMANCE RULES
//
// 1. blastRadiusService.compute(node) rebuilds the whole topology graph on every
//    call, so calling it once per affected device would mean N full graph loads
//    for N devices. We take the graph ONCE via blastRadiusService.graph() and run
//    the PURE computeBlastRadius against it per node — same engine, same result,
//    one read.
//
// 2. Cluster members are hydrated in ONE bulk read, not one read per member, and
//    through the NARROW projection. A fleet with 100 live clusters can hold tens
//    of thousands of member findings; a round trip each is what made this screen
//    take half a minute to paint. The overview only needs each member's
//    host/metric/severity to roll up — the full rows (explanation + evidence) are
//    the *fault list*, which is a separate, on-demand read (getFaults below) and
//    is deliberately NOT fetched when the screen loads.

const DEFAULT_WINDOW_MINUTES = 24 * 60;
const MAX_WINDOW_MINUTES = 7 * 24 * 60;
const DEFAULT_CLUSTER_LIMIT = 100;
const DEFAULT_ANOMALY_LIMIT = 200;
const DEFAULT_TIMELINE_LIMIT = 200;
const DEFAULT_DISCOVERY_LIMIT = 100;
// Ceiling on how many member findings the page-load rollup will hydrate. Well
// above any realistic fleet; it exists so a runaway cluster cannot turn one
// dashboard read into an unbounded scan. Members past it are not counted in the
// severity/affected-device rollup — `memberCount` (and therefore the Active
// faults figure) comes from the cluster row itself and stays exact either way.
const MAX_HYDRATED_MEMBERS = 20000;

// Defaults for the on-demand fault list (getFaults). One page is small: this is
// a drill-down an operator opens, paged, not a bulk export.
const DEFAULT_FAULT_PAGE = 100;
const MAX_FAULT_PAGE = 500;

// Agent lifecycle actions that count as timeline EVENTS. Whitelisted so the
// recurring, deduped activity rows never crowd out the limit.
const AGENT_LIFECYCLE_ACTIONS = ['agent.online', 'agent.offline', 'agent.enrolled'];

// Dates come back from the store as Date (real) or ISO string (fakes); the API
// contract is ISO or null either way.
function toIsoOrNull(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function createTroubleshootingOverviewService({
  clustersRepo = null,
  findingStore = null,
  agentsRepo = null,
  blastRadiusService = null,
  topologyChangesRepo = null,
  auditEventsRepo = null,
  discoveredDevicesRepo = null,
  logger = console,
} = {}) {
  // --- per-source fetchers (each rejects on its own backend failure) ---------

  // Live cross-agent clusters — the correlator's own rollup. `listOpen` covers
  // both 'open' and 'acknowledged'; a resolved cluster is not an active fault.
  async function fetchClusters({ limit }) {
    if (!clustersRepo || typeof clustersRepo.listOpen !== 'function') return [];
    const clusters = await clustersRepo.listOpen(limit);
    return asArray(clusters).slice(0, limit);
  }

  async function fetchAgents() {
    if (!agentsRepo || typeof agentsRepo.findAll !== 'function') return [];
    return agentsRepo.findAll();
  }

  // ONE graph read, reused for both the topology panel and every blast radius.
  async function fetchGraph() {
    if (!blastRadiusService || typeof blastRadiusService.graph !== 'function') return null;
    return blastRadiusService.graph();
  }

  // Flow-pair baseline deviations, already scored and persisted as findings by
  // flowPairBaselineJob (metric 'flow.volume').
  async function fetchAnomalies({ from, to, limit }) {
    if (!findingStore || typeof findingStore.list !== 'function') return [];
    return findingStore.list(null, from, limit, to, { metric: 'flow.volume' });
  }

  async function fetchTopologyChanges({ from, to, limit }) {
    if (!topologyChangesRepo || typeof topologyChangesRepo.list !== 'function') return [];
    return topologyChangesRepo.list({ from, to, limit });
  }

  async function fetchAgentEvents({ from, to, limit }) {
    if (!auditEventsRepo || typeof auditEventsRepo.findAll !== 'function') return [];
    // findAll takes ONE action; fan out over the lifecycle whitelist and merge.
    const perAction = await Promise.all(AGENT_LIFECYCLE_ACTIONS.map((action) => auditEventsRepo.findAll({
      actorType: 'agent', action, from, to, limit,
    })));
    return perAction.flatMap(asArray);
  }

  // Unpromoted active-discovery candidates. These are NOT topology nodes — they
  // have no agent id and no edges — so they ride alongside the graph as
  // "seen on the wire, not monitored", never as ok/down nodes.
  async function fetchDiscovered({ limit }) {
    if (!discoveredDevicesRepo || typeof discoveredDevicesRepo.list !== 'function') return [];
    return discoveredDevicesRepo.list({ status: 'discovered', limit });
  }

  // Every distinct member id across the live clusters, in cluster order.
  function memberIdsOf(clusters) {
    const ids = [];
    const seen = new Set();
    for (const c of asArray(clusters)) {
      for (const id of asArray(c && c.memberFindingIds)) {
        if (id === null || id === undefined || id === '') continue;
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        ids.push(id);
      }
    }
    return ids;
  }

  // ONE narrow bulk read for every cluster's members (see performance rule 2),
  // returned as findingId -> light finding. Missing members (retention may have
  // purged them) are simply absent, exactly as the per-id path dropped them.
  //
  // Falls back to the per-id `get` only for a store that predates listByIds —
  // the fakes and the real store both have it, so this is a compatibility shim,
  // not the normal path.
  async function hydrateMembersBulk(clusters) {
    const byId = new Map();
    const ids = memberIdsOf(clusters);
    if (!ids.length) return byId;
    const wanted = ids.slice(0, MAX_HYDRATED_MEMBERS);
    if (wanted.length < ids.length) {
      logger.warn?.(`troubleshooting: ${ids.length} cluster members exceed the ${MAX_HYDRATED_MEMBERS} hydration cap; rolling up the first ${wanted.length}`);
    }

    if (findingStore && typeof findingStore.listByIds === 'function') {
      const rows = await findingStore.listByIds(wanted, { light: true });
      for (const row of asArray(rows)) if (row && row.id != null) byId.set(String(row.id), row);
      return byId;
    }
    if (findingStore && typeof findingStore.get === 'function') {
      const fetched = await Promise.all(wanted.map((id) => Promise.resolve(findingStore.get(id)).catch(() => null)));
      for (const row of fetched) if (row && row.id != null) byId.set(String(row.id), row);
    }
    return byId;
  }

  // Blast radius for every device named by a root cause, from the single graph.
  function blastRadiusFor(graph, nodeIds) {
    const byNode = new Map();
    if (!graph) return byNode;
    for (const id of nodeIds) {
      try {
        byNode.set(id, computeBlastRadius(graph, id));
      } catch (err) {
        // Best-effort: a node the engine cannot walk costs that node's count,
        // not the panel.
        logger.warn?.(`troubleshooting: blast radius failed for node ${id}: ${err.message}`);
      }
    }
    return byNode;
  }

  // Assembles the whole payload. `now` is injectable so tests are deterministic.
  async function getOverview({
    windowMinutes = DEFAULT_WINDOW_MINUTES,
    clusterLimit = DEFAULT_CLUSTER_LIMIT,
    anomalyLimit = DEFAULT_ANOMALY_LIMIT,
    timelineLimit = DEFAULT_TIMELINE_LIMIT,
    includeDiscovery = false,
    now = () => new Date(),
  } = {}) {
    // A non-positive or unparseable window falls back to the default rather
    // than clamping to 1 minute — "-5" is a mistake, not a request for 60s.
    const raw = Number(windowMinutes);
    const wanted = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_MINUTES;
    const mins = Math.min(Math.floor(wanted), MAX_WINDOW_MINUTES);
    const to = now();
    const from = new Date(to.getTime() - mins * 60 * 1000);

    const sources = [
      ['clusters', () => fetchClusters({ limit: clusterLimit })],
      ['agents', () => fetchAgents()],
      ['graph', () => fetchGraph()],
      ['anomalies', () => fetchAnomalies({ from, to, limit: anomalyLimit })],
      ['topologyChanges', () => fetchTopologyChanges({ from, to, limit: timelineLimit })],
      ['agentEvents', () => fetchAgentEvents({ from, to, limit: timelineLimit })],
      ['discovered', () => (includeDiscovery ? fetchDiscovered({ limit: DEFAULT_DISCOVERY_LIMIT }) : Promise.resolve([]))],
    ];

    const settled = await Promise.allSettled(sources.map(([, fn]) => fn()));
    const got = {};
    const failedSources = [];
    settled.forEach((res, idx) => {
      const [name] = sources[idx];
      if (res.status === 'fulfilled') {
        got[name] = res.value;
      } else {
        failedSources.push(name);
        logger.warn?.(`troubleshooting: source ${name} failed: ${res.reason && res.reason.message}`);
        got[name] = name === 'graph' ? null : [];
      }
    });

    // --- root causes: hydrate members, then reuse the correlator's read-model
    let clusterDetails = [];
    try {
      const membersById = await hydrateMembersBulk(got.clusters);
      clusterDetails = asArray(got.clusters).map((c) => {
        const members = asArray(c.memberFindingIds)
          .map((id) => membersById.get(String(id)))
          .filter(Boolean);
        return buildClusterDetail(c, members);
      });
    } catch (err) {
      // Member hydration reads the SAME store as `anomalies`; if it dies after
      // the cluster list succeeded, drop the root-cause panel, keep the rest.
      logger.warn?.(`troubleshooting: cluster hydration failed: ${err.message}`);
      if (!failedSources.includes('clusters')) failedSources.push('clusters');
      clusterDetails = [];
    }

    // Every device that could need a blast radius: named by a cause, or down.
    const nodesOfInterest = new Set();
    for (const c of clusterDetails) {
      for (const a of asArray(c.affectedAgents)) {
        const id = toNodeId(a);
        if (id !== null) nodesOfInterest.add(id);
      }
    }
    for (const a of asArray(got.agents)) {
      if (String(a && a.status || '').toLowerCase() === 'offline') {
        const id = toNodeId(a.id);
        if (id !== null) nodesOfInterest.add(id);
      }
    }
    const blastByNode = blastRadiusFor(got.graph, nodesOfInterest);

    const rootCauses = buildRootCauses(clusterDetails, { blastByNode });
    const topology = buildTopologyView({ graph: got.graph, agents: got.agents, blastByNode });
    const anomalies = buildAnomalies(got.anomalies);

    // Timeline: the SAME pure merge the per-target timeline uses, fed the
    // fleet-wide rows. No second merge implementation.
    //
    // The merged event shape has no device field, but the overlay needs one to
    // answer "what changed on THIS device?". Rather than fork the mappers we
    // re-attach `agentId` by (source, ref_id) afterwards — the same additive
    // enrichment GET /api/topology/changes already does.
    const agentEventRows = asArray(got.agentEvents);
    const topologyChangeRows = asArray(got.topologyChanges);
    const ownerByRef = new Map();
    for (const r of agentEventRows) {
      if (r && r.id != null) ownerByRef.set(`agent:${r.id}`, toNodeId(r.actorId));
    }
    for (const r of topologyChangeRows) {
      if (r && r.id != null) ownerByRef.set(`topology:${r.id}`, toNodeId(r.agentId));
    }
    const timeline = buildTargetTimeline({
      agentEvents: agentEventRows,
      topologyChanges: topologyChangeRows,
      limit: timelineLimit,
    }).map((e) => ({ ...e, agentId: ownerByRef.get(`${e.source}:${e.ref_id}`) ?? null }));

    return {
      window: { from: from.toISOString(), to: to.toISOString(), minutes: mins },
      summary: buildSummary({ rootCauses, topology, anomalies }),
      topology: {
        ...topology,
        // Candidates seen by active discovery but not promoted to agents.
        discovered: asArray(got.discovered).map((d) => ({
          id: d.id, ip: d.ip, hostname: d.hostname ?? null, openPorts: asArray(d.openPorts), lastSeen: d.lastSeen ?? null,
        })),
      },
      rootCauses,
      anomalies,
      timeline,
      partial: failedSources.length > 0,
      failedSources,
    };
  }

  // -------------------------------------------------------------------------
  // getFaults — the RAW active-fault list, on demand.
  //
  // This is the read the overview deliberately does not do: the full finding
  // rows (explanation, evidence, deviation) behind every live root cause. On a
  // fleet carrying tens of thousands of raw alarms that is minutes of scrolling
  // and megabytes of JSON, so it is never part of painting the screen — the
  // Active faults figure links to it and the operator asks for it.
  //
  // ORDER is the root-cause order the screen already shows (clusters newest
  // activity first, members in the order the correlator grouped them), so page 2
  // continues page 1 rather than reshuffling under a stable offset.
  //
  // `total` counts the DISTINCT member ids across the live clusters. Clusters do
  // not share findings in practice, so it matches the Active faults figure the
  // link carries; if one ever did, the list refuses to show the same alarm twice
  // and the count says so honestly.
  //
  // A member whose finding is gone (retention purged it) is returned as a
  // placeholder row rather than silently dropped — otherwise a page would come
  // back short and the "x of y" counter would never reach its total.
  async function getFaults({ clusterLimit = DEFAULT_CLUSTER_LIMIT, limit = DEFAULT_FAULT_PAGE, offset = 0, clusterId = null } = {}) {
    const pageSize = Math.min(Math.max(Math.floor(Number(limit)) || DEFAULT_FAULT_PAGE, 1), MAX_FAULT_PAGE);
    const start = Math.max(Math.floor(Number(offset)) || 0, 0);

    const clusters = await fetchClusters({ limit: clusterLimit });
    const wanted = clusterId == null
      ? asArray(clusters)
      : asArray(clusters).filter((c) => c && Number(c.id) === Number(clusterId));

    // Flatten to (findingId -> owning cluster) refs, deduped, in cluster order.
    const refs = [];
    const seen = new Set();
    for (const c of wanted) {
      for (const id of asArray(c && c.memberFindingIds)) {
        if (id === null || id === undefined || id === '') continue;
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ id, clusterId: c.id, cause: c.suspectedCommonCause ?? null });
      }
    }

    const page = refs.slice(start, start + pageSize);
    const byId = new Map();
    if (page.length && findingStore && typeof findingStore.listByIds === 'function') {
      const rows = await findingStore.listByIds(page.map((r) => r.id));
      for (const row of asArray(rows)) if (row && row.id != null) byId.set(String(row.id), row);
    } else if (page.length && findingStore && typeof findingStore.get === 'function') {
      const rows = await Promise.all(page.map((r) => Promise.resolve(findingStore.get(r.id)).catch(() => null)));
      for (const row of rows) if (row && row.id != null) byId.set(String(row.id), row);
    }

    const faults = page.map((ref) => {
      const f = byId.get(String(ref.id)) || null;
      return {
        findingId: ref.id,
        clusterId: ref.clusterId,
        cause: ref.cause,
        // `missing` is the honest marker for a member whose finding retention
        // has already purged: the cluster still counts it, we just cannot show
        // what it said.
        missing: !f,
        hostId: f ? (f.hostId ?? null) : null,
        metric: f ? (f.metric ?? null) : null,
        severity: f ? (f.severity ?? null) : null,
        kind: f ? (f.kind ?? null) : null,
        observed: f ? (f.observed ?? null) : null,
        baseline: f ? (f.baseline ?? null) : null,
        deviation: f ? (f.deviation ?? null) : null,
        acked: f ? Boolean(f.acked) : false,
        explanation: f ? (f.explanation ?? null) : null,
        createdAt: f ? toIsoOrNull(f.createdAt) : null,
      };
    });

    return {
      total: refs.length,
      offset: start,
      limit: pageSize,
      returned: faults.length,
      hasMore: start + faults.length < refs.length,
      faults,
    };
  }

  return { getOverview, getFaults, DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES };
}

module.exports = {
  createTroubleshootingOverviewService,
  DEFAULT_WINDOW_MINUTES,
  MAX_WINDOW_MINUTES,
  MAX_HYDRATED_MEMBERS,
  DEFAULT_FAULT_PAGE,
  MAX_FAULT_PAGE,
  AGENT_LIFECYCLE_ACTIONS,
};
