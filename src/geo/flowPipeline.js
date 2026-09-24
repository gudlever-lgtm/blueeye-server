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
  // TimescaleDB mirror (docs/storage-split-audit.md); null unless TSDB_ENABLED.
  flowsTsdbRepo = null,
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
        // The enricher builds its record from the fields it knows; the layer-2
        // ones (VLAN, exporter in/out ifIndex) are carried across by position,
        // since enrichMany is a 1:1 map of its input.
        const out = enricher.enrichMany(raw);
        out.forEach((rec, i) => {
          const src = raw[i] || {};
          enriched.push({
            ...rec,
            vlan: rec.vlan ?? src.vlan ?? null,
            inIf: rec.inIf ?? src.inIf ?? null,
            outIf: rec.outIf ?? src.outIf ?? null,
          });
        });
      } catch (err) {
        logger.warn(`geo: enrichment failed (${err.message})`);
      }
    }
    if (enriched.length === 0) return 0;
    let stored;
    try {
      stored = await flowsRepo.insertMany(enriched);
    } catch (err) {
      logger.error(`geo: could not store flow records (${err.message})`);
      return 0;
    }
    // Mirror into the TSDB best-effort, and only what MySQL accepted: MySQL is
    // the source of truth during rollout, so a TSDB failure is logged and never
    // reaches ingest (the same rule as the results mirror in agentReports.js).
    if (flowsTsdbRepo) {
      try {
        await flowsTsdbRepo.insertMany(enriched);
      } catch (err) {
        logger.warn(`tsdb: flow_records mirror write failed (${err.message}); MySQL is source of truth`);
      }
    }
    return stored;
  }

  return { processResults };
}

module.exports = { createFlowPipeline };
