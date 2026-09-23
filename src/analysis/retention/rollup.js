'use strict';

const { median } = require('../baselines');
const { extractSamples } = require('../ingest');
const { servicePortOf } = require('../../flows/services');

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
//
// INTERNAL flows get their own rollup (flow_internal_rollup, migration 119).
// The external rollup keys on the peer's country/ASN, which an RFC1918 peer
// never has, so before this every LAN/OT conversation simply vanished with its
// raw rows after rawRetentionDays — no long-term baseline for "the SCADA
// server polls these PLCs on 502 every hour". Keyed per bucket by
// (agent, src_ip, dst_ip, proto, service port), where the service port is the
// server end of the conversation (flows/services.servicePortOf), so request and
// reply land on the same port and ephemeral client ports never become keys.
//
// BOUNDED: per (agent, bucket) only the top `internalRollupTopN` keys by bytes
// are kept as their own rows; everything below that line is folded into ONE
// overflow row per (agent, bucket) with src_ip = dst_ip = '*', proto = '' and
// service_port = 0. So the table grows by at most N+1 rows per agent per hour
// whatever the LAN does (a port scan cannot blow it up), totals still add up,
// and the rows kept are the conversations a baseline is about. The default N
// (500) sits well above what one agent reports in an hour — it sends its top
// 200 5-tuples a minute, and most of those repeat.
const OVERFLOW_IP = '*';

function createRollup({ repo, config, extract = extractSamples, logger = silentLogger }) {
  const intervalMs = (config.rollupIntervalMinutes || 60) * 60000;
  const batchSize = config.batchSize || 5000;
  const internalTopN = Number.isInteger(config.internalRollupTopN) && config.internalRollupTopN > 0
    ? config.internalRollupTopN : 500;

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

  // Aggregates internal flows before `cutoff` into bounded per-(agent, bucket)
  // rows (see the note above createRollup). Returns { rows, scanned }. A repo
  // without the dimension (older wiring / tests) contributes nothing.
  async function aggregateInternalFlows(cutoff) {
    if (typeof repo.getRawInternalFlowsBatch !== 'function') return { rows: [], scanned: 0 };
    const acc = new Map();
    const scanned = await scanInBatches(
      (afterId) => repo.getRawInternalFlowsBatch(cutoff, afterId, batchSize),
      (r) => {
        const bucket = bucketStart(r.ts, intervalMs);
        const proto = String(r.proto || '').toLowerCase().slice(0, 16);
        const port = servicePortOf(r.src_port, r.dst_port) || 0;
        const src = String(r.src_ip || '');
        const dst = String(r.dst_ip || '');
        const key = `${r.agent_id}|${bucket.toISOString()}|${src}|${dst}|${proto}|${port}`;
        let a = acc.get(key);
        if (!a) { a = { bucket, agentId: r.agent_id, src, dst, proto, port, bytes: 0, packets: 0, flowCount: 0 }; acc.set(key, a); }
        a.bytes += Number(r.bytes) || 0;
        a.packets += Number(r.packets) || 0;
        a.flowCount += Number(r.flows) || 0;
      },
    );
    // Top-N per (agent, bucket); the rest folds into one overflow row.
    const perGroup = new Map();
    for (const a of acc.values()) {
      const g = `${a.agentId}|${a.bucket.toISOString()}`;
      if (!perGroup.has(g)) perGroup.set(g, []);
      perGroup.get(g).push(a);
    }
    const rows = [];
    for (const list of perGroup.values()) {
      list.sort((x, y) => y.bytes - x.bytes);
      const kept = list.slice(0, internalTopN);
      for (const a of kept) rows.push([a.bucket, a.agentId, a.src, a.dst, a.proto, a.port, a.bytes, a.packets, a.flowCount]);
      const rest = list.slice(internalTopN);
      if (rest.length) {
        const o = rest.reduce((m, a) => ({ bytes: m.bytes + a.bytes, packets: m.packets + a.packets, flowCount: m.flowCount + a.flowCount }), { bytes: 0, packets: 0, flowCount: 0 });
        rows.push([rest[0].bucket, rest[0].agentId, OVERFLOW_IP, OVERFLOW_IP, '', 0, o.bytes, o.packets, o.flowCount]);
      }
    }
    return { rows, scanned };
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
    const internal = await aggregateInternalFlows(cutoff);
    if (acc.size > 0) {
      const rollupRows = [...acc.values()].map((a) => [
        a.bucket, a.agentId, a.direction, a.country, a.asn, a.asnName,
        a.bytes, a.packets, a.flowCount,
        a.min === Infinity ? 0 : a.min, a.max, median(a.bytesArr),
      ]);
      await repo.insertFlowRollups(rollupRows);
    }
    if (internal.rows.length) await repo.insertInternalFlowRollups(internal.rows);
    // The raw delete runs whether or not anything was rolled up. It used to be
    // skipped when no GEOLOCATED row was found, which meant a site with only
    // LAN traffic (or with geo switched off) never purged flow_records at all.
    const rawDeleted = await repo.deleteRawFlowsBefore(cutoff);
    if (scanned || internal.scanned || rawDeleted) {
      logger.info(`retention: rolled up ${scanned} external + ${internal.scanned} internal raw flows -> ${acc.size} + ${internal.rows.length} buckets; deleted ${rawDeleted} raw`);
    }
    return { buckets: acc.size, internalBuckets: internal.rows.length, rawDeleted };
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
