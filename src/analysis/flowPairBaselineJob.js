'use strict';

const crypto = require('crypto');
const { buildPairBaselines, zScore, classify, slotOf, pairKey, DEFAULT_MIN_OBSERVATIONS } = require('./flowPairBaseline');
const { FindingKind } = require('./constants');
const { loadConfig } = require('./config');
const { buildHostResolver } = require('../topology/hostResolver');

// Leader-only hourly job that (1) appends the previous complete hour's per-tuple
// TCP volume to flow_pair_hourly, (2) recomputes day-of-week/hour-of-day robust
// baselines over the window, and (3) scores that hour's tuples, emitting
// deviations to the correlator as ordinary findings (kind ANOMALY). Off the
// ingest hot path; best-effort (never throws out of the interval).
//
// Reuses the service-dependency flow+host-resolution path and the existing
// median/MAD statistics — no new statistical code, no new alerting channel.

const HOUR_MS = 60 * 60 * 1000;

function toInt(v, dflt) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt; }

function readConfig(env = process.env) {
  const a = loadConfig(env);
  return {
    windowDays: toInt(env.FLOW_BASELINE_WINDOW_DAYS, 14),
    minObservations: toInt(env.FLOW_BASELINE_MIN_OBSERVATIONS, DEFAULT_MIN_OBSERVATIONS),
    retentionDays: toInt(env.FLOW_BASELINE_RETENTION_DAYS, 21),
    intervalMinutes: toInt(env.FLOW_BASELINE_JOB_INTERVAL_MINUTES, 60),
    warnSigma: a.warnSigma,
    critSigma: a.critSigma,
  };
}

// Aggregate raw TCP flows to per-(src_host,dst_host,dst_port) volume, resolving
// each IP to a monitored host and dropping unknown/self pairs. NO Top-N here —
// baselining needs every resolvable pair, consistently. (Pure summation, not
// statistics.)
function aggregateHourly(flowRows, resolver) {
  const byEdge = new Map();
  for (const r of Array.isArray(flowRows) ? flowRows : []) {
    if (!r) continue;
    const src = resolver.resolve(r.srcIp);
    const dst = resolver.resolve(r.dstIp);
    if (src == null || dst == null || src === dst) continue;
    const port = Number(r.dstPort);
    if (!Number.isInteger(port) || port <= 0) continue;
    const key = `${src}|${dst}|${port}`;
    let e = byEdge.get(key);
    if (!e) { e = { srcHostId: src, dstHostId: dst, dstPort: port, bytes: 0, packets: 0, connCount: 0 }; byEdge.set(key, e); }
    e.bytes += Number(r.bytes) || 0;
    e.packets += Number(r.packets) || 0;
    e.connCount += Number(r.connCount) || 0;
  }
  return [...byEdge.values()];
}

function createFlowPairBaselineJob({ flowPairBaselinesRepo, flowsRepo, agentsRepo, findingStore, config = readConfig(), logger = null, now = () => new Date() }) {
  let timer = null;
  let running = false;

  function emitFinding({ row, baseline, z, severity, bucketStart, bucketEnd }) {
    if (!findingStore || typeof findingStore.save !== 'function') return null;
    const src = row.srcHostId;
    const dst = row.dstHostId;
    const port = row.dstPort;
    const finding = {
      id: crypto.randomUUID(),
      hostId: String(src), // single host key = the source/observer (correlator groups by host)
      metric: 'flow.volume',
      severity,
      kind: FindingKind.ANOMALY,
      observed: row.bytes,
      baseline: baseline.medianBytes,
      deviation: z,
      window: [bucketStart, bucketEnd],
      explanation: `Flow ${src}->${dst}:${port} volume ${row.bytes}B deviated ${z.toFixed(1)}σ from its ${baseline.medianBytes}B baseline for this weekday/hour`,
      evidence: [{ hostId: String(src), metric: 'flow.volume', value: row.bytes, ts: bucketEnd, labels: { src: String(src), dst: String(dst), dstPort: port } }],
      correlatedWith: [],
      createdAt: bucketEnd,
      acked: false,
    };
    return findingStore.save(finding);
  }

  async function run() {
    if (running) return null;
    running = true;
    try {
      const t = now();
      // Roll up the previous COMPLETE hour (epoch-grid boundary).
      const bucketEnd = new Date(Math.floor(t.getTime() / HOUR_MS) * HOUR_MS);
      const bucketStart = new Date(bucketEnd.getTime() - HOUR_MS);

      // (1) Roll up the current hour IN MEMORY (don't persist yet — the current
      // observation must NOT contaminate its own baseline).
      const agents = await agentsRepo.findAll();
      const resolver = buildHostResolver(agents);
      const flowRows = await flowsRepo.tcpServiceFlows({ from: bucketStart, to: bucketEnd });
      const hourly = aggregateHourly(flowRows, resolver).map((e) => ({ ...e, proto: 'tcp', bucket: bucketStart }));

      // (2) Recompute baselines from PRIOR history (excludes the current bucket,
      // which isn't inserted yet), then persist them + score the slot map.
      const windowRows = await flowPairBaselinesRepo.hourlySince({ since: new Date(t.getTime() - config.windowDays * 24 * HOUR_MS) });
      const baselines = buildPairBaselines(windowRows, { minObservations: config.minObservations });
      await flowPairBaselinesRepo.upsertBaselines(baselines);

      // (3) Score this hour's tuples against the (dow,hour) baseline for the slot.
      const { dow, hour } = slotOf(bucketStart);
      const bmap = new Map(baselines.filter((b) => b.dow === dow && b.hour === hour).map((b) => [pairKey(b), b]));
      let scored = 0;
      let flagged = 0;
      for (const row of hourly) {
        const b = bmap.get(pairKey(row));
        if (!b || b.observationCount < config.minObservations) continue; // gate
        scored += 1;
        const z = zScore(b, row.bytes);
        const severity = classify(z, { warnSigma: config.warnSigma, critSigma: config.critSigma });
        if (!severity) continue;
        await emitFinding({ row, baseline: b, z, severity, bucketStart, bucketEnd }); // eslint-disable-line no-await-in-loop
        flagged += 1;
      }

      // (4) NOW append the current hour (it becomes history for the next run) and
      // purge beyond retention.
      if (hourly.length) await flowPairBaselinesRepo.insertHourly(hourly);
      await flowPairBaselinesRepo.purgeHourlyBefore(new Date(t.getTime() - config.retentionDays * 24 * HOUR_MS));

      if (logger && typeof logger.info === 'function') {
        logger.info(`flow-baseline: bucket ${bucketStart.toISOString()} rolled ${hourly.length} pairs, baselines ${baselines.length}, scored ${scored}, flagged ${flagged}`);
      }
      return { bucket: bucketStart.toISOString(), pairs: hourly.length, baselines: baselines.length, scored, flagged };
    } catch (err) {
      if (logger && typeof logger.warn === 'function') logger.warn(`flow-baseline: run failed (${err && err.message})`);
      return null;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    run().catch(() => {});
    timer = setInterval(() => run().catch(() => {}), config.intervalMinutes * 60 * 1000);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { start, stop, run, aggregateHourly };
}

module.exports = { createFlowPairBaselineJob, readConfig, aggregateHourly };
