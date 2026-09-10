'use strict';

// The queue's policy layer over the runs/discovery repositories.
//
// The repositories own the atomic claim (a conditional UPDATE); this owns the
// decisions around it: what counts as stale, whether a worker is alive, and
// which schedules should be enqueued now. Keeping them apart means the storage
// contract can be tested against SQL and the policy against a clock.

// A heartbeat row this old belongs to a worker that is never coming back.
const STALE_WORKER_MS = 7 * 24 * 60 * 60 * 1000;

function createQueue({ runsRepo, discoveryRepo, schedulesRepo, workersRepo = null, settings, logger = null, now = () => new Date() }) {
  async function queueSettings() {
    try { return await settings.get('queue'); } catch {
      return { claimTimeoutMs: 600000, pollIntervalMs: 5000, workerHeartbeatTimeoutMs: 60000 };
    }
  }

  // Records that this worker is alive. Called every poll tick, so a worker is
  // visible from the moment it boots rather than from its first claim.
  async function heartbeat(worker) {
    if (!workersRepo) return null;
    try { return await workersRepo.heartbeat(worker); } catch (err) {
      if (logger && logger.warn) logger.warn(`service-tests worker: heartbeat failed (${err.message})`);
      return null;
    }
  }

  // Claims the next unit of work. Runs are preferred over discoveries: a
  // scheduled monitoring run is time-sensitive in a way a one-off crawl is not.
  async function claimNext(workerId) {
    const run = await runsRepo.claimNext(workerId);
    if (run) return { kind: 'run', job: run };
    if (discoveryRepo) {
      const discovery = await discoveryRepo.claimNext(workerId);
      if (discovery) return { kind: 'discovery', job: discovery };
    }
    return null;
  }

  // Returns claimed-but-abandoned work to a terminal state. A worker that was
  // killed mid-run leaves a row marked `running` forever otherwise, and the UI
  // would show a test that never finishes.
  async function reapStale() {
    const { claimTimeoutMs } = await queueSettings();
    const runs = await runsRepo.reapStale(claimTimeoutMs);
    const discoveries = discoveryRepo ? await discoveryRepo.reapStale(claimTimeoutMs) : 0;
    // A recreated container gets a new worker id (hostname-pid), so without this
    // the heartbeat table grows by one row per restart forever.
    if (workersRepo) {
      try { await workersRepo.prune(STALE_WORKER_MS); } catch { /* pruning is housekeeping, never a reason to stop */ }
    }
    if ((runs || discoveries) && logger && logger.warn) {
      logger.warn(`service-tests: reaped ${runs} abandoned run(s) and ${discoveries} discovery(ies)`);
    }
    return { runs, discoveries };
  }

  // Enqueues every schedule that has come due, stamping last_run_at BEFORE the
  // run is created. Stamping first means a slow enqueue cannot double-fire the
  // same schedule; the cost is that a failed enqueue skips one cycle, which is
  // the better of the two failure modes for a monitoring tool.
  async function enqueueDue() {
    if (!schedulesRepo) return [];
    const at = now();
    let due;
    try { due = await schedulesRepo.findDue(at); } catch (err) {
      if (logger && logger.warn) logger.warn(`service-tests scheduler: could not load due schedules (${err.message})`);
      return [];
    }
    const enqueued = [];
    for (const schedule of due) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await schedulesRepo.markRun(schedule.id, at);
        // eslint-disable-next-line no-await-in-loop
        const run = await runsRepo.enqueue({
          test_id: schedule.test_id,
          environment_id: schedule.environment_id,
          trigger_source: 'schedule',
        });
        enqueued.push(run);
      } catch (err) {
        if (logger && logger.warn) logger.warn(`service-tests scheduler: schedule ${schedule.id} failed to enqueue (${err.message})`);
      }
    }
    return enqueued;
  }

  // "Is anything actually processing the queue?" — answered from the worker
  // heartbeat table, so an idle worker that has never claimed a job still counts
  // as connected. Deriving it from the newest claim (the first cut) got exactly
  // one case wrong, and it was the case that mattered: a brand-new install told
  // the operator to go and set up the worker that was already running.
  //
  // The claim-derived answer is kept as the fallback for a deployment whose
  // worker predates the heartbeat table.
  async function workerStatus() {
    const { claimTimeoutMs, workerHeartbeatTimeoutMs } = await queueSettings();
    const recent = await runsRepo.list({ limit: 20 });
    const claimed = recent.filter((r) => r.claimed_at).map((r) => new Date(r.claimed_at).getTime());
    const queued = recent.filter((r) => r.status === 'queued').length;
    const newest = claimed.length ? Math.max(...claimed) : null;
    const claimAgeMs = newest ? now().getTime() - newest : null;
    const claimConnected = newest !== null && claimAgeMs < claimTimeoutMs;

    let alive = [];
    if (workersRepo) {
      try { alive = await workersRepo.listAlive(workerHeartbeatTimeoutMs || 60000); } catch (err) {
        if (logger && logger.warn) logger.warn(`service-tests: could not read worker heartbeats (${err.message})`);
      }
    }

    return {
      connected: alive.length > 0 || claimConnected,
      workers: alive.map((w) => ({
        worker_id: w.worker_id,
        hostname: w.hostname,
        version: w.version,
        started_at: w.started_at,
        last_seen_at: w.last_seen_at,
      })),
      worker_count: alive.length,
      last_seen_at: alive.length ? alive[0].last_seen_at : null,
      last_claim_at: newest ? new Date(newest) : null,
      queued,
    };
  }

  return { claimNext, reapStale, enqueueDue, heartbeat, workerStatus, queueSettings };
}

module.exports = { createQueue };
