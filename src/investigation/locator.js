'use strict';

/*
 * AUDIT FINDINGS (Fase 1 — læs inden du ændrer dette modul):
 *
 * 1. CORRELATOR DEPENDENCY GRAPH (src/analysis/correlator.js +
 *    src/analysis/dependency-graph.json):
 *    - METRISK-baseret (disk→io.await→cpu), IKKE tværgående netværkstopologi.
 *    - Grafen er en cause→effects-map (JSON), indexeret som Map<string,Set<string>>.
 *    - isAncestor(a,b) svarer via memoiseret descendants()-rekursion (cycle-safe).
 *    - Ikke anvendelig til cross-host upstream/downstream-logik; vi bruger i stedet
 *      agent-/location-gruppering + findings-tidsstempler.
 *
 * 2. LOCATION-BEGREB (migrations/001, /003, /008):
 *    - agents.location_id (INT FK → locations.id, nullable). Eneste gruppering.
 *    - Interfaces er IKKE persisteret — de er efemere og beregnes fra resultater.
 *    - Nautobot-connector: ét-vejs push (agenter→Nautobot), ingen location-sync.
 *    - ServiceNow-connector: opretter incidents (hostId + metric), ingen lokation.
 *    - Ingen IPAM-connector der mapper subnet/site → devices/interfaces.
 *    - Subnet-opslag: bedste indsats via agent-meta, ingen garanteret dækning.
 *
 * 3. FINDINGS PERSISTENS (src/analysis/findings.js, migrations/009):
 *    - Tabel: findings (id UUID, host_id, metric, severity, kind, observed,
 *      baseline, deviation, window_from/to, explanation TEXT NN, evidence JSON NN,
 *      correlated_with JSON, acked, created_at).
 *    - FindingStore.list(hostId, since, limit) — nyeste først.
 *    - Hvert finding bærer explanation (non-tom) + evidence (≥1 sample).
 *    - findings.deviation er MAD-robust z-score fra detector.js.
 *
 * 4. ROUTES + RBAC (src/routes/index.js, src/auth/middleware.js):
 *    - 43 route-filer monteret via createApiRouter().
 *    - requireAuth (Bearer JWT / API-token) + requireRole(VIEWER/OPERATOR/ADMIN).
 *    - Ingen router-bred RBAC; 404 falder igennem rent.
 *
 * 5. FEATURE GATING:
 *    - To lag: legacy proof-features (analysis/assistant/alerting/geo) +
 *      plan-service feature keys.
 *    - FORSLAG: investigation = baseline (ingen gating). Gating implementeres ikke.
 *
 * 6. MISTRAL ASSISTANT (src/analysis/assistant.js):
 *    - createAssistant({ config, findingStore, agentsRepo, locationsRepo, probeResultsRepo }).
 *    - investigationNarrative(result) tilføjet i Fase 3 via assistant.narrateInvestigation().
 *    - Sender kun aggregerede metrics/evidence, aldrig rå pakke-/payload-data.
 *
 * 7. BASELINES / MAD (src/analysis/baselines.js, src/analysis/detector.js):
 *    - median(), mad(), MAD_TO_SIGMA = 1.4826.
 *    - createBaselineStore() per ${hostId}|${metric}|${bucket(UTC-time)} nøgle.
 *    - Findings fra detector bærer allerede deviation (MAD z-score) — genbruges her.
 *
 * 8. FLOW AGGREGATION (src/repositories/flowsRepository.js):
 *    - exploreFlows(), topologyEdges(), selectFlows(), asnSeries().
 *    - topologyEdges() giver src↔dst samtaler fra 5-tuple-data.
 *    - Ikke brugt i nuværende impl. (ingen IPAM → subnet-mapning begrænset).
 */

const crypto = require('crypto');

/**
 * @typedef {'agent'|'interface'|'subnet'|'site'} LocationRefType
 *
 * @typedef {{ type: LocationRefType, value: string }} LocationRef
 *
 * @typedef {{
 *   type: string,
 *   ref: string,
 *   observed: number|null,
 *   baseline: number|null,
 *   deviation: number|null,
 *   ts: string
 * }} Evidence
 *
 * @typedef {{
 *   id: string,
 *   locationRef: LocationRef,
 *   window: { from: string, to: string },
 *   classification: 'LOCAL'|'UPSTREAM'|'DOWNSTREAM'|'APP_NOT_NET'|'INSUFFICIENT_DATA',
 *   confidence: number,
 *   explanation: string,
 *   evidence: Evidence[],
 *   suspectedSegment: { from: string, to: string }|null,
 *   relatedFindingIds: string[],
 *   workaroundHints: string[]
 * }} InvestigationResult
 */

// Metrics that indicate TCP/application-layer health issues (not network packet loss).
const APP_METRIC_FRAGMENTS = ['retransmit', 'tcp', 'app.', 'rtt.app'];
// Metrics that indicate interface/packet-level network health.
const NET_METRIC_FRAGMENTS = ['error', 'drop', 'discard', 'crc', 'loss', 'latency', 'jitter', 'packet'];

function isAppMetric(metric) {
  const m = String(metric || '').toLowerCase();
  return APP_METRIC_FRAGMENTS.some((f) => m.includes(f));
}

function isNetMetric(metric) {
  const m = String(metric || '').toLowerCase();
  return NET_METRIC_FRAGMENTS.some((f) => m.includes(f));
}

// Convert a finding to a canonical Evidence entry.
function findingToEvidence(f, tag) {
  const ref = tag ? `${f.hostId}/${f.metric} (${tag})` : `${f.hostId}/${f.metric}`;
  return {
    type: 'finding',
    ref,
    observed: f.observed ?? null,
    baseline: f.baseline ?? null,
    deviation: f.deviation ?? null,
    ts: f.createdAt ? new Date(f.createdAt).toISOString() : new Date().toISOString(),
  };
}

// Fallback evidence entry when no findings are available (ensures evidence[] is never empty).
function metaEvidence(ts) {
  return {
    type: 'meta',
    ref: 'topology-check',
    observed: 0,
    baseline: null,
    deviation: null,
    ts: ts instanceof Date ? ts.toISOString() : String(ts),
  };
}

// Agent display name, defensive.
function agentLabel(a) {
  if (!a) return 'unknown';
  return a.display_name || a.hostname || `agent-${a.id}`;
}

/**
 * Creates the investigation engine.
 *
 * @param {{
 *   agentsRepo: object,
 *   findingStore: object,
 *   locationsRepo?: object,
 *   flowsRepo?: object
 * }} deps
 */
function createLocator({ agentsRepo, findingStore, locationsRepo = null, flowsRepo = null }) {
  if (!agentsRepo || !findingStore) {
    throw new Error('createLocator requires agentsRepo and findingStore');
  }

  // Step 1: Resolve which agents belong to the locationRef.
  async function resolveAgents(locationRef) {
    const all = await agentsRepo.findAll();
    if (!Array.isArray(all) || all.length === 0) return [];

    const { type, value } = locationRef;
    const v = String(value || '').trim();
    const vLower = v.toLowerCase();

    if (type === 'agent') {
      return all.filter(
        (a) => String(a.id) === v || (a.hostname || '').toLowerCase() === vLower
      );
    }

    if (type === 'site') {
      return all.filter(
        (a) => String(a.location_id) === v ||
          (a.location_name || '').toLowerCase() === vLower
      );
    }

    if (type === 'subnet') {
      // Best-effort: match via agent meta JSON or hostname. Falls back to all
      // agents when no match can be established (no IPAM; subnet→agent mapping
      // is not persisted).
      const byMeta = all.filter((a) => {
        const meta = a.meta && typeof a.meta === 'object' ? JSON.stringify(a.meta) : '';
        return meta.includes(v) || (a.hostname || '').toLowerCase().includes(vLower);
      });
      return byMeta.length > 0 ? byMeta : all;
    }

    if (type === 'interface') {
      // Interfaces are ephemeral (not persisted). Return all agents and note the
      // limitation in the explanation; the caller sets low confidence.
      return all;
    }

    return [];
  }

  // Step 2: Resolve neighbor agents (all agents NOT in the local set).
  async function resolveNeighbors(localAgentIds) {
    const all = await agentsRepo.findAll();
    const localSet = new Set(localAgentIds.map(String));
    return (Array.isArray(all) ? all : []).filter((a) => !localSet.has(String(a.id)));
  }

  // Step 3: Collect findings for a set of agent IDs within [from, to].
  async function collectFindings(agentIds, from, to) {
    const results = [];
    for (const agentId of agentIds) {
      // eslint-disable-next-line no-await-in-loop
      const fs = await findingStore.list(String(agentId), from, 200);
      for (const f of (Array.isArray(fs) ? fs : [])) {
        const t = f.createdAt ? new Date(f.createdAt) : null;
        if (t && t >= from && t <= to) results.push(f);
      }
    }
    return results;
  }

  // Step 4: Classify and build InvestigationResult.
  function classify({ localAgents, neighborAgents, localFindings, neighborFindings, locationRef, from, to }) {
    const id = crypto.randomUUID();
    const window = { from: from.toISOString(), to: to.toISOString() };
    const windowMinutes = Math.round((to - from) / 60000);
    const toISO = to.toISOString();

    const relatedFindingIds = localFindings.map((f) => f.id).filter(Boolean);
    const localEvidence = localFindings.slice(0, 15).map((f) => findingToEvidence(f, 'local'));

    // --- INSUFFICIENT_DATA: ingen agenter fundet ---
    if (localAgents.length === 0) {
      return {
        id, locationRef, window,
        classification: 'INSUFFICIENT_DATA',
        confidence: 0,
        explanation: `No agents found for location reference ${locationRef.type}="${locationRef.value}". ` +
          'Cannot determine fault location without measurement data from the site.',
        evidence: [metaEvidence(toISO)],
        suspectedSegment: null,
        relatedFindingIds: [],
        workaroundHints: [
          `Register a BlueEye agent on ${locationRef.type}="${locationRef.value}" to enable topology diagnosis.`,
          'Verify that the agent is online and reporting to the server.',
        ],
      };
    }

    // Split findings into app-layer vs. net-layer.
    const appFindings = localFindings.filter((f) => isAppMetric(f.metric));
    const netFindings = localFindings.filter((f) => isNetMetric(f.metric));

    // --- APP_NOT_NET: app-metrics afviger, ingen netværkstæller-anomalier ---
    if (appFindings.length > 0 && netFindings.length === 0 && neighborFindings.length === 0) {
      const appMetrics = [...new Set(appFindings.map((f) => f.metric))].slice(0, 4).join(', ');
      const names = localAgents.map(agentLabel).join(', ');
      return {
        id, locationRef, window,
        classification: 'APP_NOT_NET',
        confidence: 0.7,
        explanation:
          `Application-layer anomalies (${appMetrics}) observed on ${names}, but no ` +
          'network-counter deviations and no concurrent signs of problems at neighbors. ' +
          'The fault points away from the network — investigate the server or application layer.',
        evidence: localEvidence.length > 0 ? localEvidence : [metaEvidence(toISO)],
        suspectedSegment: null,
        relatedFindingIds,
        workaroundHints: [
          'Check application logs and server resources (CPU, memory, disk access).',
          'Compare TCP retransmission patterns with application response times.',
          'Consider whether it is a capacity problem on the server rather than the network.',
        ],
      };
    }

    // --- Ingen lokale anomalier overhovedet ---
    if (localFindings.length === 0) {
      if (neighborFindings.length === 0) {
        return {
          id, locationRef, window,
          classification: 'INSUFFICIENT_DATA',
          confidence: 0.3,
          explanation:
            `No anomalies found in the time window (${windowMinutes} min) for ` +
            `${locationRef.type}="${locationRef.value}" or neighbors. ` +
            'The fault is either not measurable yet, is resolved, or falls outside the selected window.',
          evidence: [metaEvidence(toISO)],
          suspectedSegment: null,
          relatedFindingIds: [],
          workaroundHints: [
            'Widen the time window (try 60 min) and run the investigation again.',
            'Verify that agents are online and actively reporting measurement data.',
          ],
        };
      }

      // Naboer har anomalier men stedet selv er sundt → downstream
      const neighborNames = [...new Set(neighborFindings.map((f) => f.hostId))].slice(0, 3).join(', ');
      const neighborEvidence = neighborFindings.slice(0, 10).map((f) => findingToEvidence(f, 'downstream-neighbor'));
      return {
        id, locationRef, window,
        classification: 'DOWNSTREAM',
        confidence: 0.6,
        explanation:
          `The location "${locationRef.value}" is itself healthy, but neighbors (${neighborNames}) show ` +
          `anomalies. The fault appears to lie downstream (after this point).`,
        evidence: neighborEvidence.length > 0 ? neighborEvidence : [metaEvidence(toISO)],
        suspectedSegment: null,
        relatedFindingIds: neighborFindings.map((f) => f.id).filter(Boolean),
        workaroundHints: [
          'Investigate the downstream neighbors showing deviations.',
          'Check whether downstream segments have interface errors or capacity problems.',
        ],
      };
    }

    // --- Lokale anomalier findes. Sammenlign med naboer ---

    if (neighborFindings.length > 0) {
      const earliestLocal = localFindings.reduce(
        (min, f) => { const t = f.createdAt ? new Date(f.createdAt).getTime() : Infinity; return t < min ? t : min; },
        Infinity
      );
      const earliestNeighbor = neighborFindings.reduce(
        (min, f) => { const t = f.createdAt ? new Date(f.createdAt).getTime() : Infinity; return t < min ? t : min; },
        Infinity
      );

      // Nabo-anomali ≥ 3 min TIDLIGERE end lokal → upstream
      const leadMinutes = Math.round((earliestLocal - earliestNeighbor) / 60000);
      if (earliestNeighbor < earliestLocal - 3 * 60 * 1000) {
        const neighborHostIds = [...new Set(neighborFindings.map((f) => f.hostId))];
        const earliestNeighborFinding = neighborFindings.reduce(
          (best, f) => !best || new Date(f.createdAt) < new Date(best.createdAt) ? f : best,
          null
        );
        const suspectedNeighborId = earliestNeighborFinding?.hostId;
        const suspectedNeighborAgent = neighborAgents.find((a) => String(a.id) === String(suspectedNeighborId));
        const neighborName = agentLabel(suspectedNeighborAgent || { id: suspectedNeighborId });
        const localName = localAgents.map(agentLabel).join(', ');
        const neighborMetrics = [...new Set(neighborFindings.map((f) => f.metric))].slice(0, 3).join(', ');

        const allEvidence = [
          ...localFindings.slice(0, 5).map((f) => findingToEvidence(f, 'local')),
          ...neighborFindings.slice(0, 5).map((f) => findingToEvidence(f, 'upstream')),
        ];

        return {
          id, locationRef, window,
          classification: 'UPSTREAM',
          confidence: neighborHostIds.length >= 2 ? 0.75 : 0.6,
          explanation:
            `Anomalies on upstream neighbor "${neighborName}" (${neighborMetrics}) occurred ` +
            `${leadMinutes} min BEFORE the local fault on "${localName}". ` +
            `The symptom is likely inherited from an upstream link — investigate "${neighborName}" first.`,
          evidence: allEvidence.length > 0 ? allEvidence : [metaEvidence(toISO)],
          suspectedSegment: { from: neighborName, to: localName },
          relatedFindingIds: [
            ...relatedFindingIds,
            ...neighborFindings.map((f) => f.id).filter(Boolean),
          ],
          workaroundHints: [
            `Investigate "${neighborName}" — it is the likely source of the fault.`,
            `Consider rerouting traffic around "${neighborName}" while the fault is being fixed.`,
            'Check the routing log and interface counters on the suspected segment.',
          ],
        };
      }
    }

    // --- LOCAL: anomalier koncentreret på stedet, naboer sunde eller samtidige ---
    const names = localAgents.map(agentLabel).join(', ');
    const metrics = [...new Set(localFindings.map((f) => f.metric))].slice(0, 5).join(', ');
    const maxDev = localFindings.reduce(
      (best, f) => (typeof f.deviation === 'number' && f.deviation > best ? f.deviation : best),
      0
    );
    const confidence = neighborAgents.length === 0 ? 0.5
      : neighborFindings.length === 0 ? 0.8
        : 0.65;
    const neighborNote = neighborFindings.length === 0
      ? 'The neighbors are healthy.'
      : `Neighbors show ${neighborFindings.length} concurrent deviation(s) but NO temporal precursor.`;

    return {
      id, locationRef, window,
      classification: 'LOCAL',
      confidence,
      explanation:
        `Deviation is concentrated on ${names} (${metrics}; max ${maxDev.toFixed(1)}σ). ` +
        `${neighborNote} The fault appears to sit locally on this segment.`,
      evidence: localEvidence.length > 0 ? localEvidence : [metaEvidence(toISO)],
      suspectedSegment: null,
      relatedFindingIds,
      workaroundHints: buildLocalHints(localFindings, names),
    };
  }

  function buildLocalHints(findings, agentName) {
    const hints = [];
    const metrics = findings.map((f) => String(f.metric || '').toLowerCase());
    if (metrics.some((m) => m.includes('cpu') || m.includes('load'))) {
      hints.push(`Investigate CPU/load causes on ${agentName} — high CPU can block network packets.`);
    }
    if (metrics.some((m) => m.includes('error') || m.includes('drop') || m.includes('discard'))) {
      hints.push('Check cable/SFP and switch port for physical errors (CRC, runt frames, discards).');
    }
    if (metrics.some((m) => m.includes('mem'))) {
      hints.push('Investigate whether memory pressure causes packet loss via buffer overflow.');
    }
    if (hints.length === 0) {
      hints.push(`Investigate interface counters and system log on ${agentName}.`);
    }
    hints.push(
      'Compare with baseline times (same weekday, same time of day) to distinguish seasonal patterns from faults.'
    );
    return hints;
  }

  /**
   * Run a full investigation for a location reference.
   *
   * @param {{
   *   locationRef: LocationRef,
   *   windowMinutes?: number,
   *   baselineWeeks?: number
   * }} opts
   * @returns {Promise<InvestigationResult>}
   */
  async function runInvestigation({ locationRef, windowMinutes = 30, baselineWeeks = 2 }) {
    if (!locationRef || typeof locationRef !== 'object') {
      throw new Error('locationRef is required');
    }
    if (!locationRef.type || !locationRef.value) {
      throw new Error('locationRef must have type and value');
    }
    if (!['agent', 'interface', 'subnet', 'site'].includes(locationRef.type)) {
      throw new Error(`unknown locationRef.type: ${locationRef.type}`);
    }

    const wMin = Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : 30;
    // baselineWeeks is accepted for API compatibility; findings already carry
    // deviation from the MAD baseline so we don't re-compute here.
    void baselineWeeks;

    const now = new Date();
    const from = new Date(now.getTime() - wMin * 60 * 1000);
    const to = now;

    // Steps 1-2: topology resolution
    const localAgents = await resolveAgents(locationRef);
    const localAgentIds = localAgents.map((a) => String(a.id));
    const neighborAgents = await resolveNeighbors(localAgentIds);

    // Cap neighbor lookup to 20 agents to avoid N+1 database explosion.
    const sampledNeighborIds = neighborAgents.slice(0, 20).map((a) => String(a.id));

    // Step 3: gather findings in window
    const [localFindings, neighborFindings] = await Promise.all([
      collectFindings(localAgentIds, from, to),
      collectFindings(sampledNeighborIds, from, to),
    ]);

    // Step 4: classify
    return classify({
      localAgents,
      neighborAgents,
      localFindings,
      neighborFindings,
      locationRef,
      from,
      to,
    });
  }

  return { runInvestigation };
}

module.exports = { createLocator, isAppMetric, isNetMetric };
