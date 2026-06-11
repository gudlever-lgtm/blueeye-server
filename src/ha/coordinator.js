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
  // After a voluntary step-down, suspend re-contention for this long so a
  // follower wins the lock instead of the just-drained node grabbing it back on
  // the very next tick. Long enough to drain/patch; auto-recovers if the node is
  // never restarted (so a mistaken step-down isn't permanent).
  stepDownCooldownMs = 60000,
  // Licence entitlement for HA. Clustering (leader election + the cluster
  // registry) only activates when this gate grants `ha_deployment`; without it a
  // node with HA_ENABLED degrades to a plain standalone node (runs its own jobs,
  // no election). Checked LAZILY each tick, so a node whose licence validates a
  // moment after boot starts clustering on its own — no startup race. When no
  // gate is wired (unit tests), entitlement is assumed.
  featureGate = null,
  featureKey = 'ha_deployment',
  now = () => Date.now(),
  logger = silentLogger,
} = {}) {
  function entitled() {
    if (!featureGate || typeof featureGate.isFeatureEnabled !== 'function') return true;
    try { return featureGate.isFeatureEnabled(featureKey) === true; } catch { return false; }
  }
  // True only when HA is BOTH configured (env) AND licensed. This is what drives
  // real clustering; otherwise the node behaves as a standalone single node.
  function clustering() {
    return enabled && entitled();
  }

  // Standalone (not clustering) installs are leader from the start; clustering
  // nodes earn leadership via the lock.
  let leader = !clustering();
  let jobsRunning = false;
  let leaderSince = clustering() ? null : new Date().toISOString();
  let timer = null;
  // While set to a future timestamp, this node will not contend for leadership
  // (set by stepDown to drain the node for maintenance).
  let recontendPausedUntil = 0;

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
    // Only clustering nodes register in the cluster view; a standalone or
    // unlicensed node never writes a heartbeat row.
    if (!nodesRepo || !clustering()) return;
    try {
      await nodesRepo.heartbeat({
        nodeId, hostname, pid, version, isLeader: leader,
      });
    } catch (err) {
      logger.warn(`ha: heartbeat write failed (${err.message})`);
    }
  }

  function draining() {
    return !leader && recontendPausedUntil > now();
  }

  async function tickOnce() {
    if (!enabled) return;
    // Configured but not licensed for HA → run as a standalone leader: keep the
    // singleton jobs on this node, but never contend for the lock or register in
    // the cluster view. If/when the licence validates, the branch below takes over.
    if (!entitled()) {
      if (!leader) await applyLeadership(true);
      else if (!jobsRunning) startJobs();
      return;
    }
    // While draining after a voluntary step-down, stand down: don't contend for
    // the lock (so a follower takes over), but keep heartbeating as a follower.
    if (lock && !draining()) {
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
    if (!entitled()) {
      // HA configured but the licence doesn't (yet) include ha_deployment: run
      // the jobs locally as a standalone node and keep re-checking on each tick.
      logger.warn('ha: HA_ENABLED set but licence feature ha_deployment is not present — running standalone (no clustering) until entitled');
      startJobs();
    } else {
      logger.info(`ha: enabled — node ${nodeId} joining the cluster (lock contention every ${intervalMs}ms)`);
    }
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
    // Only meaningful for a licensed, clustering node.
    if (!clustering() || !lock) return { ok: false, reason: 'ha_disabled' };
    if (!leader) return { ok: false, reason: 'not_leader' };
    // Pause re-contention BEFORE releasing, so the next tick can't reacquire.
    recontendPausedUntil = now() + stepDownCooldownMs;
    await lock.release();
    await applyLeadership(false);
    return { ok: true, drainingUntil: new Date(recontendPausedUntil).toISOString() };
  }

  function isLeader() {
    return leader;
  }

  function getStatus() {
    return {
      enabled,
      // Whether HA clustering is actually active (configured AND licensed). When
      // false on an `enabled` node, the licence doesn't include ha_deployment and
      // the node is running standalone.
      clustering: clustering(),
      licensed: entitled(),
      nodeId,
      hostname,
      pid,
      version,
      role: leader ? 'leader' : 'follower',
      isLeader: leader,
      leaderSince,
      jobsRunning,
      draining: draining(),
      lockName: lock ? lock.status().lockName : null,
    };
  }

  async function listNodes() {
    if (!clustering() || !nodesRepo) {
      // Standalone (or unlicensed): the cluster is just this node.
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
