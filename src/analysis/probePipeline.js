'use strict';

const { evaluateProbeFindings } = require('./probeFindings');
const { clusterSuppressedIds, storedOr } = require('./pipeline');
const { MAX_REFIRE_COOLDOWN_MS } = require('../eventCases/activityWindow');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// Runs probe-based findings AFTER probe-results ingest — the active-probe twin of
// the traffic analysis pipeline. It does not duplicate ingestion: the caller has
// already persisted the probe rows; this evaluates the agent's recent rows,
// de-dupes against findings already raised in a cooldown window, then saves,
// publishes (dashboard WS) and alerts. Gated by the SAME analysis license+flag
// (and alerting by the alerting flag). Best-effort and resilient — a failure here
// never affects ingestion.
//
//   const pipe = createProbePipeline({ probeResultsRepo, findingStore, config, ... });
//   await pipe.processAgent(agentId);
function createProbePipeline({
  probeResultsRepo,
  findingStore,
  config,
  publishFinding = () => {},
  dispatcher = null,
  alertingEnabled = false,
  integrationTrigger = null,
  eventCaseService = null,
  // Dispatch-time cluster suppression, exactly as the analysis pipeline applies
  // it: a finding whose host is already covered by an open medium/high cluster
  // does not alert or emit to ITSM on its own (the ONE cluster alert covers
  // it). It is still saved, published and grouped. Nullable → no suppression.
  clusterAlertGate = null,
  licensed = () => true,
  // Optional offline GeoIP/ASN provider — passed to the evaluator so it can map
  // traceroute hop IPs to ASNs for AS-path change detection. null → that check is
  // skipped; all other findings are unaffected.
  geoProvider = null,
  windowMs = 6 * 3600 * 1000, // how far back to look for the verdict
  // Don't re-raise the same (metric,target) within this. It must stay inside
  // the event-case activity window (with slack for the next probe), or an
  // ongoing fault re-raises after its event has closed and opens a new one each
  // time — see ../eventCases/activityWindow.js. Was 30 min against a 15 min
  // window, i.e. a fresh event case about every half hour on the same host.
  cooldownMs = MAX_REFIRE_COOLDOWN_MS,
  evaluate = evaluateProbeFindings,
  now = () => new Date(),
  logger = silentLogger,
}) {
  // Identifies a finding by what it is about, so the same ongoing problem isn't
  // re-raised on every probe ingest.
  function keyOf(f) {
    const target = (f.evidence && f.evidence[0] && f.evidence[0].target) || '';
    return `${f.metric}|${target}`;
  }

  async function processAgent(agentId) {
    // Gated by BOTH the license (analysis) and the config flag.
    if (!config || !config.analysisEnabled || !licensed()) return [];

    let rows;
    try {
      // findByAgent returns oldest-first; computeAgentHealth wants newest-first.
      const asc = await probeResultsRepo.findByAgent({ agentId, from: new Date(now().getTime() - windowMs), limit: 2000 });
      rows = Array.isArray(asc) ? asc.slice().reverse() : [];
    } catch (err) {
      logger.warn(`probe-analysis: could not load rows for ${agentId} (${err.message})`);
      return [];
    }
    if (!rows.length) return [];

    let candidates;
    try {
      candidates = evaluate(agentId, rows, { now, geoProvider });
    } catch (err) {
      logger.error(`probe-analysis: evaluate threw for ${agentId} (${err.message})`);
      return [];
    }
    if (!candidates.length) return [];

    // De-dupe against recent findings (cooldown) so frequent probes don't spam
    // the findings list / alert channels with the same ongoing problem.
    let recent = [];
    try {
      recent = await findingStore.list(String(agentId), new Date(now().getTime() - cooldownMs));
    } catch (err) {
      logger.warn(`probe-analysis: could not load recent findings (${err.message})`);
      recent = [];
    }
    const recentKeys = new Set(recent.map(keyOf));
    const fresh = candidates.filter((f) => !recentKeys.has(keyOf(f)));

    const produced = [];
    for (const finding of fresh) {
      try {
        // The stored finding carries the severity rules' verdict; publish,
        // group and alert on that (see storedOr).
        const stored = storedOr(await findingStore.save(finding), finding);
        produced.push(stored);
        try {
          publishFinding(stored.hostId, { type: 'finding', payload: stored });
        } catch (err) {
          logger.warn(`probe-analysis: publish failed (${err.message})`);
        }
      } catch (err) {
        logger.error(`probe-analysis: could not save finding (${err.message})`);
      }
    }

    // Event cases: group each produced probe finding into an open event on
    // its device (within the window) or open a new one. Sequential + best-effort.
    if (eventCaseService && produced.length > 0) {
      for (const finding of produced) {
        try {
          await eventCaseService.assignFinding(finding);
        } catch (err) {
          logger.warn(`probe-analysis: event assignment failed for ${finding.id} (${err.message})`);
        }
      }
    }

    // Cluster-suppressed findings, computed once (shared by alerting + ITSM emit).
    const suppressed = produced.length > 0 ? await clusterSuppressedIds(clusterAlertGate, produced) : new Set();

    // alertingEnabled may be a live getter so a runtime enable/disable applies.
    const alertOn = typeof alertingEnabled === 'function' ? alertingEnabled() : alertingEnabled;
    if (dispatcher && alertOn && produced.length > 0) {
      for (const finding of produced) {
        if (suppressed.has(finding.id)) continue; // rolled into an open cluster
        try {
          await dispatcher.dispatch(finding, null);
        } catch (err) {
          logger.warn(`probe-analysis: dispatch failed for ${finding.id} (${err.message})`);
        }
      }
    }
    // Outbound integrations (ITSM/IPAM). Fire-and-forget; independent of alerting.
    // Cluster-suppressed findings are NOT emitted — the ONE cluster ticket covers them.
    if (integrationTrigger && typeof integrationTrigger.emitFinding === 'function') {
      for (const finding of produced) {
        if (suppressed.has(finding.id)) continue;
        try { integrationTrigger.emitFinding(finding).catch(() => {}); } catch { /* never affects ingestion */ }
      }
    }
    return produced;
  }

  return { processAgent };
}

module.exports = { createProbePipeline };
