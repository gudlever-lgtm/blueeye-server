'use strict';

const { groupRows, deriveSequenceState, METRICS } = require('./detection');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// True when severity `a` is strictly more severe than `b` (critical > warning).
const isWorse = (a, b) => a === 'critical' && b === 'warning';

// Derives incidents from active-probe results. Runs AFTER probe-results ingest
// (the active-probe twin of the analysis pipeline) — it does not persist probe
// rows itself; it reads the agent's recent rows, computes the DESIRED incident
// state per (metric, target) with threshold + debounce rules, then reconciles
// against the stored incidents: opens new ones, resolves recovered ones, and
// never creates a duplicate active incident for the same tuple.
//
// Best-effort and resilient — a failure here must never break ingestion.
//
//   const svc = createIncidentService({ incidentsRepo, thresholdsRepo, agentsRepo, probeResultsRepo });
//   await svc.processAgent(agentId);
function createIncidentService({
  incidentsRepo,
  thresholdsRepo,
  agentsRepo,
  probeResultsRepo,
  windowMs = 24 * 3600 * 1000, // how far back to look when reconciling
  now = () => new Date(),
  logger = silentLogger,
}) {
  // Caches the effective threshold per (locationId, metric) for one pass.
  function thresholdLoader(locationId) {
    const cache = new Map();
    return async (metric) => {
      if (cache.has(metric)) return cache.get(metric);
      const t = await thresholdsRepo.getEffective(locationId, metric);
      cache.set(metric, t);
      return t;
    };
  }

  async function processAgent(agentId) {
    let agent;
    try {
      agent = await agentsRepo.findById(agentId);
    } catch (err) {
      logger.warn(`incidents: could not load agent ${agentId} (${err.message})`);
      return { opened: 0, resolved: 0 };
    }
    if (!agent) return { opened: 0, resolved: 0 };
    const locationId = agent.location_id ?? null;

    let rows;
    try {
      // findByAgent returns oldest-first — exactly what the sequence walk wants.
      rows = await probeResultsRepo.findByAgent({
        agentId,
        from: new Date(now().getTime() - windowMs),
        limit: 5000,
      });
    } catch (err) {
      logger.warn(`incidents: could not load probe rows for ${agentId} (${err.message})`);
      return { opened: 0, resolved: 0 };
    }
    if (!Array.isArray(rows) || rows.length === 0) return { opened: 0, resolved: 0 };

    const getThreshold = thresholdLoader(locationId);
    let opened = 0;
    let resolved = 0;

    for (const group of groupRows(rows)) {
      if (!METRICS.includes(group.metric)) continue;
      let threshold;
      try {
        threshold = await getThreshold(group.metric);
      } catch (err) {
        logger.warn(`incidents: threshold lookup failed (${group.metric}): ${err.message}`);
        continue;
      }
      if (!threshold) continue; // no threshold configured ⇒ nothing to derive

      const desired = deriveSequenceState(group.rows, group.metric, threshold);

      let active;
      try {
        active = await incidentsRepo.findActive(agentId, group.metric, group.target);
      } catch (err) {
        logger.warn(`incidents: active lookup failed (${err.message})`);
        continue;
      }

      try {
        if (desired.open) {
          if (!active) {
            await incidentsRepo.open({
              location_id: locationId,
              agent_id: agentId,
              metric: group.metric,
              severity: desired.severity,
              started_at: desired.startedAt,
              affected_target: group.target,
            });
            opened += 1;
          } else if (isWorse(desired.severity, active.severity)) {
            // No duplicate — but escalate the existing incident when the run has
            // crossed into a higher severity (e.g. warning → critical), so the
            // reports/NIS2 draft don't keep showing the stale severity.
            await incidentsRepo.updateSeverity(active.id, desired.severity);
          }
        } else if (active) {
          // The service is healthy again. Prefer the recovery transition the
          // window actually saw; fall back to the first healthy sample for the
          // case where the failing run scrolled out of the lookback (so the
          // incident still resolves instead of lingering active forever).
          const recoveryAt = desired.lastRecoveryAt || desired.firstHealthyAt;
          if (recoveryAt) {
            const ok = await incidentsRepo.resolve(active.id, recoveryAt);
            if (ok) resolved += 1;
          }
        }
      } catch (err) {
        logger.error(`incidents: reconcile failed for ${group.metric}/${group.target} (${err.message})`);
      }
    }

    return { opened, resolved };
  }

  return { processAgent };
}

module.exports = { createIncidentService };
