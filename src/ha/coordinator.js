'use strict';

const os = require('os');

const silentLogger = { info() {}, warn() {}, error() {} };

// Ties leader election together with the actual high-availability behaviour:
//
//   * starts/stops the LEADER-ONLY singleton jobs (retention, test-package
//     scheduler, GeoIP auto-update) as this node gains/loses leadership;
//   * periodically ticks the election and writes a heartbeat row so every node
//     in the cluster is visible in the status/admin API and the dashboard;
//   * exposes a small status surface for `GET /api/ha/*`.
//
// HA is OPT-IN. When `enabled` is false the node behaves exactly as a classic
// single-node install: it is permanently "leader", runs every job, and never
// touches the lock or the heartbeat table. This keeps existing deployments
// (and the whole test suite) byte-for-byte unchanged.
function createHaCoordinator({
  enabled = false,
  nodeId,
  lock = null, // createLeaderLock(...) — required when enabled
  nodesRepo = null, // haNodesRepository — optional cluster registry
  jobs = [], // [{ start(), stop() }] singleton background work, leader-only
  intervalMs = 10000,
  version = null,
  hostname = os.hostname(),
  pid = process.pid,
  // Treat a node as "active" in the cluster view if seen within this window.
  activeWindowSec = 60,
  logger = silentLogger,
} = {}) {
  // Single-node installs are leader from the start; HA nodes earn it via the lock.
  let leader = !enabled;
  let jobsRunning = false;
  let leaderSince = enabled ? null : new Date().toISOString();
  let timer = null;

  function startJobs() {
    if (jobsRunning) return;
    jobsRunning = true;
    for (const job of jobs) {
      try { job.start(); } catch (err) { logger.error(`ha: job start failed (${err && err.message})`); }
    }
  }

  function stopJobs() {
    if (!jobsRunning) return;
    jobsRunning = false;
    for (const job of jobs) {
      try { job.stop(); } catch (err) { logger.error(`ha: job stop failed (${err && err.message})`); }
    }
  }

  // Apply a leadership transition: (de)start the singleton jobs and record it.
  // Called only when the lock's leadership actually flips, so it's idempotent.
  async function applyLeadership(isLeader) {
    leader = isLeader;
    leaderSince = isLeader ? new Date().toISOString() : null;
    if (isLeader) {
      logger.info(`ha: node ${nodeId} is now LEADER — starting singleton jobs`);
      startJobs();
    } else {
      logger.info(`ha: node ${nodeId} is now a FOLLOWER — stopping singleton jobs`);
      stopJobs();
    }
    await heartbeat();
  }

  async function heartbeat() {
    if (!nodesRepo) return;
    try {
      await nodesRepo.heartbeat({
        nodeId, hostname, pid, version, isLeader: leader,
      });
    } catch (err) {
      logger.warn(`ha: heartbeat write failed (${err.message})`);
    }
  }

  async function tickOnce() {
    if (!enabled) return;
    if (lock) {
      await lock.tick();
      // React to any leadership change the tick produced (promotion on a free
      // lock, or demotion if our connection dropped).
      const nowLeader = lock.isLeader();
      if (nowLeader !== leader) await applyLeadership(nowLeader);
    }
    await heartbeat();
  }

  async function start() {
    if (!enabled) {
      // Classic single node: run everything, no election, no registry.
      logger.info('ha: disabled — running as a standalone node (all singleton jobs active)');
      startJobs();
      return;
    }
    logger.info(`ha: enabled — node ${nodeId} joining the cluster (lock contention every ${intervalMs}ms)`);
    await tickOnce();
    timer = setInterval(() => { tickOnce().catch((err) => logger.error('ha: tick failed:', err)); }, intervalMs);
    if (timer.unref) timer.unref();
  }

  async function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    // Stop the singleton jobs first (synchronous, never depends on the DB), then
    // release the lock so a follower can promote, then clear our registry flag.
    stopJobs();
    if (enabled && nodesRepo) {
      try { await nodesRepo.markStopped(nodeId); } catch { /* best effort */ }
    }
    if (enabled && lock) {
      try { await lock.release(); } catch (err) { logger.warn(`ha: lock release on shutdown failed (${err.message})`); }
    }
  }

  // Voluntary step-down (admin). On an HA node this releases the lock; a follower
  // promotes on its next tick. A no-op on a standalone node.
  async function stepDown() {
    if (!enabled || !lock) return { ok: false, reason: 'ha_disabled' };
    if (!leader) return { ok: false, reason: 'not_leader' };
    await lock.release();
    await applyLeadership(false);
    return { ok: true };
  }

  function isLeader() {
    return leader;
  }

  function getStatus() {
    return {
      enabled,
      nodeId,
      hostname,
      pid,
      version,
      role: leader ? 'leader' : 'follower',
      isLeader: leader,
      leaderSince,
      jobsRunning,
      lockName: lock ? lock.status().lockName : null,
    };
  }

  async function listNodes() {
    if (!nodesRepo) {
      // Standalone: the cluster is just this node.
      return [{
        node_id: nodeId, hostname, pid, version,
        is_leader: leader, active: true, last_seen_at: new Date().toISOString(),
      }];
    }
    try {
      return await nodesRepo.listActive(activeWindowSec);
    } catch (err) {
      logger.warn(`ha: listNodes failed (${err.message})`);
      return [];
    }
  }

  return { start, stop, tickOnce, stepDown, isLeader, getStatus, listNodes, applyLeadership };
}

module.exports = { createHaCoordinator };
