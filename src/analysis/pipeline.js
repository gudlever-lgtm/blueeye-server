'use strict';

const { extractSamples } = require('./ingest');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// Glues the detector + finding store + WS publish behind the analysis feature
// flag, so the ingest handler can call a single method. It does NOT duplicate
// the ingest pipeline — it runs AFTER the existing persistence on the samples
// derived from the already-stored payloads.
//
//   const pipeline = createAnalysisPipeline({ detector, findingStore, config, publishFinding });
//   await pipeline.processResults(hostId, payloads);
function createAnalysisPipeline({
  detector,
  findingStore,
  config,
  publishFinding = () => {},
  extract = extractSamples,
  correlator = null,
  correlationWindowMs = 60000,
  incidentCaseService = null,
  dispatcher = null,
  alertingEnabled = false,
  integrationTrigger = null,
  licensed = () => true,
  logger = silentLogger,
}) {
  // Correlates the freshly produced findings together with recently stored ones
  // for the same hosts, then persists the resulting links. Best-effort: any
  // failure here is logged and swallowed so it never affects ingestion. Runs
  // after each batch (the existing per-batch scheduling point).
  async function correlateAndPersist(produced) {
    const hostIds = [...new Set(produced.map((f) => f.hostId))];
    const since = new Date(Date.now() - correlationWindowMs);
    const pool = produced.slice();
    for (const hostId of hostIds) {
      let recent = [];
      try {
        recent = await findingStore.list(hostId, since);
      } catch (err) {
        logger.warn(`analysis: could not load recent findings for correlation (${err.message})`);
        recent = [];
      }
      for (const r of recent) {
        if (!pool.some((f) => f.id === r.id)) pool.push(r);
      }
    }
    const groups = correlator.correlate(pool, correlationWindowMs);
    for (const group of groups) {
      if (!group.findings || group.findings.length < 2) continue;
      for (const f of group.findings) {
        try {
          await findingStore.setCorrelations(f.id, f.correlatedWith || []);
        } catch (err) {
          logger.warn(`analysis: could not persist correlation for ${f.id} (${err.message})`);
        }
      }
    }
    return groups;
  }

  // Sends produced findings to the alerting channels (behind the feature flag).
  // Each finding is dispatched with the correlation group it belongs to, if any.
  // Best-effort: a dispatch failure never affects ingestion.
  async function dispatchAlerts(produced, groups) {
    const groupOf = new Map();
    for (const g of groups || []) {
      for (const f of g.findings || []) groupOf.set(f.id, g);
    }
    for (const finding of produced) {
      try {
        await dispatcher.dispatch(finding, groupOf.get(finding.id) || null);
      } catch (err) {
        logger.warn(`alerting: dispatch failed for ${finding.id} (${err.message})`);
      }
    }
  }

  // Evaluates every metric sample in a batch of result payloads; saves and
  // publishes any findings. Resilient: a failure on one finding doesn't abort
  // the rest, and analysis errors never break ingestion (the caller persists
  // first). Returns the findings produced.
  async function processResults(hostId, payloads) {
    // Gated by BOTH the license (may the customer use it) and the config flag
    // (has the customer switched it on).
    if (!config || !config.analysisEnabled || !licensed()) return [];
    const produced = [];
    const batch = Array.isArray(payloads) ? payloads : [];
    for (const payload of batch) {
      let samples = [];
      try {
        samples = extract(hostId, payload);
      } catch (err) {
        logger.warn(`analysis: could not extract samples (${err.message})`);
        continue;
      }
      for (const sample of samples) {
        let finding = null;
        try {
          finding = detector.evaluate(sample);
        } catch (err) {
          logger.error(`analysis: detector threw on ${sample.metric} (${err.message})`);
          continue;
        }
        if (!finding) continue;
        try {
          await findingStore.save(finding);
          produced.push(finding);
          // Push to UI over the SAME WebSocket as a 'finding' event.
          try {
            publishFinding(finding.hostId, { type: 'finding', payload: finding });
          } catch (err) {
            logger.warn(`analysis: publish failed (${err.message})`);
          }
        } catch (err) {
          logger.error(`analysis: could not save finding (${err.message})`);
        }
      }
    }
    // Incident cases: place each produced finding into an open incident on its
    // device (grouping within the window) or open a new one. Sequential so that
    // same-batch findings on one host land in the same incident. Best-effort —
    // an assignment failure never affects ingestion.
    if (incidentCaseService && produced.length > 0) {
      for (const finding of produced) {
        try {
          await incidentCaseService.assignFinding(finding);
        } catch (err) {
          logger.warn(`analysis: incident assignment failed for ${finding.id} (${err.message})`);
        }
      }
    }
    // Root-cause correlation across the batch (+ recent findings). Best-effort.
    let groups = [];
    if (correlator && produced.length > 0) {
      try {
        groups = await correlateAndPersist(produced) || [];
      } catch (err) {
        logger.warn(`analysis: correlation step failed (${err.message})`);
      }
    }
    // Alerting: route findings to channels (behind the alerting feature flag).
    // alertingEnabled may be a live getter so a runtime enable/disable applies.
    const alertOn = typeof alertingEnabled === 'function' ? alertingEnabled() : alertingEnabled;
    if (dispatcher && alertOn && produced.length > 0) {
      try {
        await dispatchAlerts(produced, groups);
      } catch (err) {
        logger.warn(`alerting: dispatch step failed (${err.message})`);
      }
    }
    // Outbound integrations: push each finding to configured ITSM/IPAM targets
    // (ServiceNow incident, etc.). Fire-and-forget so the dispatcher's own
    // retry/backoff never slows or breaks ingestion; it is independent of the
    // alerting flag (a customer may push to ServiceNow without local alerting).
    if (integrationTrigger && typeof integrationTrigger.emitFinding === 'function') {
      for (const finding of produced) {
        try { integrationTrigger.emitFinding(finding).catch(() => {}); } catch { /* never affects ingestion */ }
      }
    }
    return produced;
  }

  return { processResults };
}

module.exports = { createAnalysisPipeline };
