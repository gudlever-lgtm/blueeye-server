'use strict';

const { median } = require('../baselines');
const { extractSamples } = require('../ingest');

const silentLogger = { info() {}, warn() {}, error() {} };

// Aligns a timestamp down to the start of its rollup bucket.
function bucketStart(ts, intervalMs) {
  const t = (ts instanceof Date ? ts : new Date(ts)).getTime();
  return new Date(Math.floor(t / intervalMs) * intervalMs);
}

// Down-samples raw data older than `beforeTs` into rollup tables, then deletes
// the raw rows it summarised. Idempotent: because the raw rows are deleted once
// aggregated, a repeated run finds nothing to aggregate and double-counts
// nothing. Aggregation is done in JS so true min/max/median are available.
function createRollup({ repo, config, extract = extractSamples, logger = silentLogger }) {
  const intervalMs = (config.rollupIntervalMinutes || 60) * 60000;
  const batchSize = config.batchSize || 5000;

  async function rollupFlows(beforeTs) {
    const acc = new Map();
    let afterId = 0;
    let scanned = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await repo.getRawExternalFlowsBatch(beforeTs, afterId, batchSize);
      if (!rows.length) break;
      for (const r of rows) {
        afterId = Math.max(afterId, r.id);
        scanned += 1;
        const bucket = bucketStart(r.ts, intervalMs);
        const direction = r.direction === 'in' ? 'in' : 'out';
        const country = r.country || '';
        const asn = r.asn || 0;
        const key = `${r.agent_id}|${bucket.toISOString()}|${direction}|${country}|${asn}`;
        let a = acc.get(key);
        if (!a) { a = { bucket, agentId: r.agent_id, direction, country, asn, asnName: r.asn_name || null, bytes: 0, packets: 0, flowCount: 0, bytesArr: [] }; acc.set(key, a); }
        const b = Number(r.bytes) || 0;
        a.bytes += b; a.packets += Number(r.packets) || 0; a.flowCount += Number(r.flows) || 0;
        a.bytesArr.push(b);
        if (r.asn_name && !a.asnName) a.asnName = r.asn_name;
      }
      if (rows.length < batchSize) break;
    }
    if (acc.size === 0) return { buckets: 0, rawDeleted: 0 };
    const rollupRows = [...acc.values()].map((a) => [
      a.bucket, a.agentId, a.direction, a.country, a.asn, a.asnName,
      a.bytes, a.packets, a.flowCount,
      Math.min(...a.bytesArr), Math.max(...a.bytesArr), median(a.bytesArr),
    ]);
    await repo.insertFlowRollups(rollupRows);
    const rawDeleted = await repo.deleteRawFlowsBefore(beforeTs);
    logger.info(`retention: rolled up ${scanned} raw flows -> ${acc.size} buckets; deleted ${rawDeleted} raw`);
    return { buckets: acc.size, rawDeleted };
  }

  async function rollupMetrics(beforeTs) {
    const acc = new Map();
    let afterId = 0;
    let scanned = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await repo.getRawResultsBatch(beforeTs, afterId, batchSize);
      if (!rows.length) break;
      for (const r of rows) {
        afterId = Math.max(afterId, r.id);
        scanned += 1;
        let payload = r.payload;
        if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
        const samples = extract(r.agent_id, payload, () => r.created_at) || [];
        for (const s of samples) {
          if (typeof s.value !== 'number' || Number.isNaN(s.value)) continue;
          const bucket = bucketStart(s.ts || r.created_at, intervalMs);
          const key = `${r.agent_id}|${s.metric}|${bucket.toISOString()}`;
          let a = acc.get(key);
          if (!a) { a = { bucket, agentId: r.agent_id, metric: s.metric, vals: [] }; acc.set(key, a); }
          a.vals.push(s.value);
        }
      }
      if (rows.length < batchSize) break;
    }
    if (acc.size === 0) {
      const rawDeleted = scanned > 0 ? await repo.deleteRawResultsBefore(beforeTs) : 0;
      return { buckets: 0, rawDeleted };
    }
    const rollupRows = [...acc.values()].map((a) => [
      a.bucket, a.agentId, a.metric, a.vals.length, Math.min(...a.vals), Math.max(...a.vals), median(a.vals),
    ]);
    await repo.insertMetricRollups(rollupRows);
    const rawDeleted = await repo.deleteRawResultsBefore(beforeTs);
    logger.info(`retention: rolled up ${scanned} raw results -> ${acc.size} metric buckets; deleted ${rawDeleted} raw`);
    return { buckets: acc.size, rawDeleted };
  }

  return { rollupFlows, rollupMetrics, bucketStart };
}

module.exports = { createRollup, bucketStart };
