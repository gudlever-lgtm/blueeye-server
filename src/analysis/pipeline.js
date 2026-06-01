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
  logger = silentLogger,
}) {
  // Evaluates every metric sample in a batch of result payloads; saves and
  // publishes any findings. Resilient: a failure on one finding doesn't abort
  // the rest, and analysis errors never break ingestion (the caller persists
  // first). Returns the findings produced.
  async function processResults(hostId, payloads) {
    if (!config || !config.analysisEnabled) return [];
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
    return produced;
  }

  return { processResults };
}

module.exports = { createAnalysisPipeline };
