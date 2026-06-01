'use strict';

const { extractFlows } = require('./extractFlows');

const silentLogger = { info() {}, warn() {}, error() {} };

// Glues flow extraction + geo enrichment + storage behind the geo feature flag,
// so the ingest handler can call one method. Runs AFTER the results are already
// persisted and is fully best-effort: any failure here is logged and swallowed
// so it can never break ingestion.
//
//   const flows = createFlowPipeline({ flowsRepo, enricher, config });
//   await flows.processResults(agentId, payloads);
function createFlowPipeline({
  flowsRepo,
  enricher,
  config = {},
  extract = extractFlows,
  logger = silentLogger,
}) {
  // Extracts, enriches and stores flow records for a batch of result payloads.
  // Returns the number of flow rows stored.
  async function processResults(agentId, payloads) {
    if (config.geoEnabled === false) return 0;
    const batch = Array.isArray(payloads) ? payloads : [];
    const enriched = [];
    for (const payload of batch) {
      let raw = [];
      try {
        raw = extract(agentId, payload);
      } catch (err) {
        logger.warn(`geo: could not extract flows (${err.message})`);
        continue;
      }
      if (!raw.length) continue;
      try {
        for (const rec of enricher.enrichMany(raw)) enriched.push(rec);
      } catch (err) {
        logger.warn(`geo: enrichment failed (${err.message})`);
      }
    }
    if (enriched.length === 0) return 0;
    try {
      return await flowsRepo.insertMany(enriched);
    } catch (err) {
      logger.error(`geo: could not store flow records (${err.message})`);
      return 0;
    }
  }

  return { processResults };
}

module.exports = { createFlowPipeline };
