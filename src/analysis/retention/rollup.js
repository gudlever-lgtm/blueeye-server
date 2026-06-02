'use strict';

const { median } = require('../baselines');
const { extractSamples } = require('../ingest');

const silentLogger = { info() {}, warn() {}, error() {} };

// Aligns a timestamp down to the start of its rollup bucket.
function bucketStart(ts, intervalMs) {
  const t = (ts instanceof Date ? ts : new Date(ts)).getTime();
  return new Date(Math.floor(t / intervalMs) * intervalMs);
}

// Down-samples raw data older than `beforeTs` into the rollup tables, then
// deletes the raw rows before that cutoff. This is the ONLY place raw
// results/flows are purged (purge.js trims only the rollup tables), so rows
// past the cutoff are deleted whether or not each one yielded a rollup sample.
// Idempotent: aggregated rows are gone by the next run, so nothing is
// double-counted. Aggregation runs in JS so true min/max/median are available.
function createRollup({ repo, config, extract = extractSamples, logger = silentLogger }) {
  const intervalMs = (config.rollupIntervalMinutes || 60) * 60000;
  const batchSize = config.batchSize || 5000;

  // Scans rows in keyset-paginated batches (ascending id), calling onRow for
  // each; returns the number of rows scanned. Stops on a short/empty batch.
  async function scanInBatches(getBatch, onRow) {
    let afterId = 0;
    let scanned = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await getBatch(afterId);
      if (!rows.length) break;
      for (const r of rows) {
        afterId = Math.max(afterId, r.id);
        scanned += 1;
        onRow(r);
      }
      if (rows.length < batchSize) break;
    }
    return scanned;
  }

  async function rollupFlows(beforeTs) {
    // Floor to a bucket boundary so only WHOLE buckets are aggregated and
    // deleted — a bucket is never split across two runs, which keeps the median
    // exact (no cross-run merge) and the rollup idempotent.
    const cutoff = bucketStart(beforeTs, intervalMs);
    const acc = new Map();
    const scanned = await scanInBatches(
      (afterId) => repo.getRawExternalFlowsBatch(cutoff, afterId, batchSize),
      (r) => {
        const bucket = bucketStart(r.ts, intervalMs);
        const direction = r.direction === 'in' ? 'in' : 'out';
        const country = r.country || '';
        const asn = r.asn || 0;
        const key = `${r.agent_id}|${bucket.toISOString()}|${direction}|${country}|${asn}`;
        let a = acc.get(key);
        if (!a) { a = { bucket, agentId: r.agent_id, direction, country, asn, asnName: r.asn_name || null, bytes: 0, packets: 0, flowCount: 0, bytesArr: [], min: Infinity, max: 0 }; acc.set(key, a); }
        const b = Number(r.bytes) || 0;
        a.bytes += b; a.packets += Number(r.packets) || 0; a.flowCount += Number(r.flows) || 0;
        a.bytesArr.push(b);
        if (b < a.min) a.min = b;
        if (b > a.max) a.max = b;
        if (r.asn_name && !a.asnName) a.asnName = r.asn_name;
      },
    );
    if (acc.size === 0) return { buckets: 0, rawDeleted: 0 };
    const rollupRows = [...acc.values()].map((a) => [
      a.bucket, a.agentId, a.direction, a.country, a.asn, a.asnName,
      a.bytes, a.packets, a.flowCount,
      a.min === Infinity ? 0 : a.min, a.max, median(a.bytesArr),
    ]);
    await repo.insertFlowRollups(rollupRows);
    const rawDeleted = await repo.deleteRawFlowsBefore(cutoff);
    logger.info(`retention: rolled up ${scanned} raw flows -> ${acc.size} buckets; deleted ${rawDeleted} raw`);
    return { buckets: acc.size, rawDeleted };
  }

  async function rollupMetrics(beforeTs) {
    const cutoff = bucketStart(beforeTs, intervalMs); // whole-bucket aggregation (see rollupFlows)
    const acc = new Map();
    const scanned = await scanInBatches(
      (afterId) => repo.getRawResultsBatch(cutoff, afterId, batchSize),
      (r) => {
        let payload = r.payload;
        if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
        const samples = extract(r.agent_id, payload, () => r.created_at) || [];
        for (const s of samples) {
          if (typeof s.value !== 'number' || Number.isNaN(s.value)) continue;
          const bucket = bucketStart(s.ts || r.created_at, intervalMs);
          const key = `${r.agent_id}|${s.metric}|${bucket.toISOString()}`;
          let a = acc.get(key);
          if (!a) { a = { bucket, agentId: r.agent_id, metric: s.metric, vals: [], min: Infinity, max: -Infinity }; acc.set(key, a); }
          a.vals.push(s.value);
          if (s.value < a.min) a.min = s.value;
          if (s.value > a.max) a.max = s.value;
        }
      },
    );
    if (acc.size === 0) {
      // Scanned raw results but extracted no numeric samples (payloads with
      // neither system metrics nor traffic.totals). They're still past the
      // cutoff and rollup is the only raw-results purge, so delete them per the
      // retention policy — but warn, since a NEW unhandled payload type would
      // otherwise be dropped here silently.
      if (scanned > 0) {
        logger.warn(`retention: ${scanned} raw results before cutoff produced no rollup samples — deleting per raw retention`);
        const rawDeleted = await repo.deleteRawResultsBefore(cutoff);
        return { buckets: 0, rawDeleted };
      }
      return { buckets: 0, rawDeleted: 0 };
    }
    const rollupRows = [...acc.values()].map((a) => [
      a.bucket, a.agentId, a.metric, a.vals.length, a.min, a.max, median(a.vals),
    ]);
    await repo.insertMetricRollups(rollupRows);
    const rawDeleted = await repo.deleteRawResultsBefore(cutoff);
    logger.info(`retention: rolled up ${scanned} raw results -> ${acc.size} metric buckets; deleted ${rawDeleted} raw`);
    return { buckets: acc.size, rawDeleted };
  }

  return { rollupFlows, rollupMetrics, bucketStart };
}

module.exports = { createRollup, bucketStart };
